/**
 * Reports — the questions an owner (or their accountant) asks.
 *
 * GET /api/reports/valuation
 *   Per product: units on hand, cost value, retail value.
 *   "What is my stock worth right now?"
 *
 * GET /api/reports/summary?from=2026-07-01&to=2026-07-09
 *   Per movement type: how many movements, net quantity.
 *   "What happened in this period?"
 */
import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler, AppError } from "../../middleware/error.js";
import { requireAuth, type AuthRequest } from "../../middleware/auth.js";
import { grandTotal } from "../invoices/inv.service.js";
import { grossProfit } from "../../lib/costing.js";
import { reorderReport } from "../reorder/reorder.service.js";

// The client sends exact universal instants (ISO format, e.g.
// "2026-07-08T18:30:00.000Z") — IT knows the user's timezone; we don't.
const dateRangeSchema = z.object({
  from: z.string().datetime({ message: "Use ISO datetime" }),
  to: z.string().datetime({ message: "Use ISO datetime" }),
});

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

reportsRouter.get(
  "/valuation",
  asyncHandler(async (req: AuthRequest, res) => {
    const companyId = req.user!.companyId;

    // total quantity per product (across all locations)
    const grouped = await prisma.stockMovement.groupBy({
      by: ["productId"],
      where: { companyId },
      _sum: { quantity: true },
    });

    const products = await prisma.product.findMany({
      where: { id: { in: grouped.map((g) => g.productId) }, companyId },
      select: {
        id: true,
        sku: true,
        name: true,
        unit: true,
        costPrice: true,
        sellingPrice: true,
        avgCost: true,
        isActive: true,
      },
    });
    const productById = new Map(products.map((p) => [p.id, p]));

    const rows = grouped
      .map((g) => {
        const p = productById.get(g.productId);
        if (!p) return null;
        // Quantity is Decimal since P1-2, and so are the prices. Multiply
        // as Decimals and convert ONCE at the end — a valuation report that
        // drifts by a paisa per row is a valuation report nobody trusts.
        const quantity = g._sum.quantity ?? new Prisma.Decimal(0);
        return {
          productId: p.id,
          sku: p.sku,
          name: p.name,
          unit: p.unit,
          isActive: p.isActive,
          quantity: Number(quantity),
          // avgCost, NOT costPrice (P1-3). costPrice is whatever someone last
          // typed; avgCost is what the stock on this shelf actually cost us.
          avgCost: Number(p.avgCost),
          costValue: Number(quantity.times(p.avgCost).toDecimalPlaces(2)),
          retailValue: Number(quantity.times(p.sellingPrice).toDecimalPlaces(2)),
        };
      })
      .filter((r) => r !== null)
      .sort((a, b) => b!.costValue - a!.costValue); // biggest money first

    const totals = rows.reduce(
      (acc, r) => ({
        quantity: acc.quantity + r!.quantity,
        costValue: Math.round((acc.costValue + r!.costValue) * 100) / 100,
        retailValue:
          Math.round((acc.retailValue + r!.retailValue) * 100) / 100,
      }),
      { quantity: 0, costValue: 0, retailValue: 0 }
    );

    res.json({ rows, totals });
  })
);

/**
 * GET /api/reports/top-products?from&to&limit
 * Best sellers for a period: SALE movements grouped per product,
 * biggest absolute quantity first. Powers the dashboard chart.
 */
reportsRouter.get(
  "/top-products",
  asyncHandler(async (req: AuthRequest, res) => {
    const { from, to } = dateRangeSchema.parse(req.query);
    const companyId = req.user!.companyId;

    const grouped = await prisma.stockMovement.groupBy({
      by: ["productId"],
      where: {
        companyId,
        type: "SALE",
        createdAt: { gte: new Date(from), lte: new Date(to) },
      },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: "asc" } }, // sales are negative: most negative = most sold
      take: 5,
    });

    const products = await prisma.product.findMany({
      where: { id: { in: grouped.map((g) => g.productId) }, companyId },
      select: { id: true, name: true, sku: true, unit: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    res.json(
      grouped
        .map((g) => {
          const p = byId.get(g.productId);
          if (!p) return null;
          return {
            productId: p.id,
            name: p.name,
            sku: p.sku,
            unit: p.unit,
            // Sales are stored negative; report them positive.
            unitsSold: Number((g._sum.quantity ?? new Prisma.Decimal(0)).abs()),
          };
        })
        .filter((r) => r !== null)
    );
  })
);

reportsRouter.get(
  "/summary",
  asyncHandler(async (req: AuthRequest, res) => {
    const { from, to } = dateRangeSchema.parse(req.query);
    const companyId = req.user!.companyId;

    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (fromDate > toDate) throw new AppError(400, "'from' is after 'to'");

    const grouped = await prisma.stockMovement.groupBy({
      by: ["type"],
      where: { companyId, createdAt: { gte: fromDate, lte: toDate } },
      _sum: { quantity: true },
      _count: { _all: true },
    });

    res.json(
      grouped.map((g) => ({
        type: g.type,
        movements: g._count._all,
        netQuantity: Number(g._sum.quantity ?? new Prisma.Decimal(0)),
      }))
    );
  })
);

/**
 * GET /api/reports/sales-over-time?from&to&tzOffset
 *   Units SOLD per day across a date range — powers the sales trend chart.
 *   "How did my sales move day by day?"
 *
 * Timezone note: a "day" needs a timezone to know where midnight falls.
 * The browser sends `tzOffset` = its Date.getTimezoneOffset() value (minutes
 * that must be ADDED to local time to reach UTC — e.g. IST is -330). We shift
 * each movement's instant by that offset before slicing off the date, so a
 * sale lands on the day the USER made it, not the day it happened in UTC.
 * (This is the fix for the old UTC-vs-IST report bug.)
 */
const salesSeriesSchema = dateRangeSchema.extend({
  // querystrings are strings — coerce to a number; default 0 = treat as UTC
  tzOffset: z.coerce.number().int().default(0),
});

// Shift a UTC instant into the user's local clock, then return its YYYY-MM-DD.
function localDayKey(instant: Date, tzOffset: number): string {
  const shifted = new Date(instant.getTime() - tzOffset * 60_000);
  return shifted.toISOString().slice(0, 10);
}

reportsRouter.get(
  "/sales-over-time",
  asyncHandler(async (req: AuthRequest, res) => {
    const { from, to, tzOffset } = salesSeriesSchema.parse(req.query);
    const companyId = req.user!.companyId;

    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (fromDate > toDate) throw new AppError(400, "'from' is after 'to'");

    // Only the raw sales in the window — pull the two fields we need.
    const sales = await prisma.stockMovement.findMany({
      where: {
        companyId,
        type: "SALE",
        createdAt: { gte: fromDate, lte: toDate },
      },
      select: { createdAt: true, quantity: true },
    });

    // Bucket into a map: local-day -> units sold (sales are negative, so flip).
    const byDay = new Map<string, number>();
    for (const s of sales) {
      const key = localDayKey(s.createdAt, tzOffset);
      byDay.set(key, (byDay.get(key) ?? 0) + Number(s.quantity.abs()));
    }

    // Fill EVERY day in the range (even zero-sale days) so the chart has an
    // unbroken line instead of jumping over gaps.
    const series: { date: string; unitsSold: number }[] = [];
    const cursor = new Date(localDayKey(fromDate, tzOffset) + "T00:00:00.000Z");
    const lastKey = localDayKey(toDate, tzOffset);
    while (true) {
      const key = cursor.toISOString().slice(0, 10);
      series.push({ date: key, unitsSold: byDay.get(key) ?? 0 });
      if (key === lastKey) break;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    res.json(series);
  })
);

/**
 * GET /api/reports/purchasing?from&to
 *   Buying summary over a period: order counts by status, committed spend
 *   (non-cancelled PO value), value actually received into stock, and a
 *   spend-by-supplier breakdown. "What am I buying, and from whom?"
 */
reportsRouter.get(
  "/purchasing",
  asyncHandler(async (req: AuthRequest, res) => {
    const { from, to } = dateRangeSchema.parse(req.query);
    const companyId = req.user!.companyId;
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (fromDate > toDate) throw new AppError(400, "'from' is after 'to'");

    const round2 = (n: number) => Math.round(n * 100) / 100;

    const pos = await prisma.purchaseOrder.findMany({
      where: { companyId, createdAt: { gte: fromDate, lte: toDate } },
      include: {
        supplier: { select: { id: true, name: true } },
        lines: { select: { quantity: true, receivedQty: true, unitCost: true } },
      },
    });

    const byStatus: Record<string, number> = {};
    const bySupplier = new Map<
      string,
      { supplierId: string; name: string; orders: number; totalCost: number }
    >();
    let committedCost = 0;
    let receivedValue = 0;

    for (const po of pos) {
      byStatus[po.status] = (byStatus[po.status] ?? 0) + 1;

      // Decimal per line, one Number() at the end — see P1-2.
      const ordered = Number(
        po.lines.reduce(
          (s, l) => s.plus(l.unitCost.times(l.quantity)),
          new Prisma.Decimal(0)
        )
      );
      const received = Number(
        po.lines.reduce(
          (s, l) => s.plus(l.unitCost.times(l.receivedQty)),
          new Prisma.Decimal(0)
        )
      );
      receivedValue += received;
      const counts = po.status !== "CANCELLED";
      if (counts) committedCost += ordered;

      const row =
        bySupplier.get(po.supplier.id) ?? {
          supplierId: po.supplier.id,
          name: po.supplier.name,
          orders: 0,
          totalCost: 0,
        };
      row.orders += 1;
      if (counts) row.totalCost += ordered;
      bySupplier.set(po.supplier.id, row);
    }

    res.json({
      totals: {
        orders: pos.length,
        committedCost: round2(committedCost),
        receivedValue: round2(receivedValue),
      },
      byStatus,
      bySupplier: [...bySupplier.values()]
        .map((s) => ({ ...s, totalCost: round2(s.totalCost) }))
        .sort((a, b) => b.totalCost - a.totalCost),
    });
  })
);

/**
 * GET /api/reports/expiring?days=30
 *   Batches (from incoming stock-in movements that carry an expiry date)
 *   expiring within the next N days, plus anything already expired. Oldest
 *   expiry first. "What's about to go off?"
 */
reportsRouter.get(
  "/expiring",
  asyncHandler(async (req: AuthRequest, res) => {
    const days = Math.min(
      365,
      Math.max(1, Number(req.query.days ?? 30) || 30)
    );
    const companyId = req.user!.companyId;
    const now = new Date();
    const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const rows = await prisma.stockMovement.findMany({
      where: {
        companyId,
        quantity: { gt: 0 }, // incoming batches only
        expiryDate: { not: null, lte: cutoff },
      },
      orderBy: { expiryDate: "asc" },
      include: {
        product: { select: { id: true, name: true, sku: true, unit: true } },
        location: { select: { name: true } },
      },
    });

    const dayMs = 24 * 60 * 60 * 1000;
    res.json(
      rows.map((m) => ({
        movementId: m.id,
        product: m.product,
        location: m.location.name,
        batchNumber: m.batchNumber,
        expiryDate: m.expiryDate,
        quantity: m.quantity,
        daysLeft: Math.ceil(
          (new Date(m.expiryDate!).getTime() - now.getTime()) / dayMs
        ),
      }))
    );
  })
);

/**
 * GET /api/reports/sales?from&to
 *   Revenue from issued/paid invoices in the window: total, by product, and
 *   by customer. The selling mirror of the purchasing report.
 */
reportsRouter.get(
  "/sales",
  asyncHandler(async (req: AuthRequest, res) => {
    const { from, to } = dateRangeSchema.parse(req.query);
    const companyId = req.user!.companyId;
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (fromDate > toDate) throw new AppError(400, "'from' is after 'to'");
    const round2 = (n: number) => Math.round(n * 100) / 100;

    const invoices = await prisma.invoice.findMany({
      where: {
        companyId,
        status: { in: ["ISSUED", "PAID"] },
        issuedAt: { gte: fromDate, lte: toDate },
      },
      include: {
        lines: {
          include: { product: { select: { id: true, name: true, unit: true } } },
        },
      },
    });

    const byProduct = new Map<
      string,
      { productId: string; name: string; unit: string; units: number; revenue: number }
    >();
    const byCustomer = new Map<
      string,
      { name: string; invoices: number; revenue: number }
    >();
    let totalRevenue = 0;

    for (const inv of invoices) {
      const subtotal = Number(
        inv.lines.reduce(
          (s, l) => s.plus(l.unitPrice.times(l.quantity)),
          new Prisma.Decimal(0)
        )
      );
      // The ACTUAL money for this invoice — after discount, plus tax — same
      // as the invoice total the customer sees.
      const invTotal = grandTotal(subtotal, inv.taxRate, inv.discount);
      totalRevenue += invTotal;

      const c = byCustomer.get(inv.customerName) ?? {
        name: inv.customerName,
        invoices: 0,
        revenue: 0,
      };
      c.invoices += 1;
      c.revenue += invTotal;
      byCustomer.set(inv.customerName, c);

      for (const l of inv.lines) {
        const lineSub = Number(l.unitPrice.times(l.quantity));
        // Spread the invoice's discount/tax across lines by their share of
        // the subtotal, so per-product revenue sums back to the invoice total.
        const rev = subtotal > 0 ? invTotal * (lineSub / subtotal) : 0;
        const p = byProduct.get(l.productId) ?? {
          productId: l.productId,
          name: l.product.name,
          unit: l.product.unit,
          units: 0,
          revenue: 0,
        };
        p.units += Number(l.quantity);
        p.revenue += rev;
        byProduct.set(l.productId, p);
      }
    }

    res.json({
      totals: { revenue: round2(totalRevenue), invoices: invoices.length },
      byProduct: [...byProduct.values()]
        .map((p) => ({ ...p, revenue: round2(p.revenue) }))
        .sort((a, b) => b.revenue - a.revenue),
      byCustomer: [...byCustomer.values()]
        .map((c) => ({ ...c, revenue: round2(c.revenue) }))
        .sort((a, b) => b.revenue - a.revenue),
    });
  })
);

/**
 * GET /api/reports/reorder
 *   Active products at/below their low-stock threshold, with a suggested
 *   reorder quantity and the preferred supplier — so you can draft a PO in
 *   one click. "What should I buy, and from whom?"
 */
reportsRouter.get(
  "/reorder",
  asyncHandler(async (req: AuthRequest, res) => {
    // Delegates to the P1-8 location-aware service. This endpoint used to sum
    // stock across every location before comparing against one company-wide
    // threshold, which meant a nearly-empty warehouse raised no warning as
    // long as some OTHER warehouse was full (PRD §11). Kept as an alias so
    // existing callers don't break; /api/reorder is the canonical path.
    const locationId =
      typeof req.query.locationId === "string" ? req.query.locationId : undefined;
    res.json(await reorderReport(req.user!.companyId, { locationId }));
  })
);

/**
 * GET /api/reports/profitability?from&to
 *
 * Revenue, COGS, gross profit and margin — the three figures the PRD insists
 * on keeping distinct (§7), plus a per-product breakdown.
 *
 * This is NOT `sellingPrice − costPrice`. Every SALE movement carries the
 * weighted-average cost that applied at the moment it happened, so these
 * numbers are a sum over recorded facts and cannot drift when today's prices
 * change. That is the difference between a profit report and a guess.
 */
reportsRouter.get(
  "/profitability",
  asyncHandler(async (req: AuthRequest, res) => {
    const companyId = req.user!.companyId;
    const { from, to } = dateRangeSchema.parse(req.query);
    const fromDate = new Date(from);
    const toDate = new Date(to);

    // Revenue comes from ISSUED/PAID invoices in the window — what we billed.
    const invoices = await prisma.invoice.findMany({
      where: {
        companyId,
        status: { in: ["ISSUED", "PAID"] },
        issuedAt: { gte: fromDate, lte: toDate },
      },
      include: { lines: { include: { product: { select: { id: true, sku: true, name: true } } } } },
    });

    // COGS comes from the LEDGER, not the invoices — every SALE movement
    // already knows what it cost.
    const sales = await prisma.stockMovement.findMany({
      where: {
        companyId,
        type: "SALE",
        createdAt: { gte: fromDate, lte: toDate },
      },
      select: { productId: true, quantity: true, costAtTime: true },
    });

    type Row = {
      productId: string;
      sku: string;
      name: string;
      revenue: Prisma.Decimal;
      cogs: Prisma.Decimal;
      unitsSold: Prisma.Decimal;
    };
    const byProduct = new Map<string, Row>();
    const zero = () => new Prisma.Decimal(0);

    for (const inv of invoices) {
      for (const l of inv.lines) {
        const row =
          byProduct.get(l.productId) ??
          {
            productId: l.productId,
            sku: l.product.sku,
            name: l.product.name,
            revenue: zero(),
            cogs: zero(),
            unitsSold: zero(),
          };
        row.revenue = row.revenue.plus(l.unitPrice.times(l.quantity));
        byProduct.set(l.productId, row);
      }
    }

    for (const m of sales) {
      const row = byProduct.get(m.productId);
      if (!row) continue; // sold without an invoice (direct movement)
      const qty = m.quantity.abs();
      row.unitsSold = row.unitsSold.plus(qty);
      if (m.costAtTime) row.cogs = row.cogs.plus(qty.times(m.costAtTime));
    }

    const rows = [...byProduct.values()]
      .map((r) => {
        const { profit, margin } = grossProfit(r.revenue, r.cogs);
        return {
          productId: r.productId,
          sku: r.sku,
          name: r.name,
          unitsSold: Number(r.unitsSold),
          revenue: Number(r.revenue.toDecimalPlaces(2)),
          cogs: Number(r.cogs.toDecimalPlaces(2)),
          grossProfit: Number(profit),
          margin: Number(margin),
        };
      })
      .sort((a, b) => b.grossProfit - a.grossProfit);

    const totalRevenue = [...byProduct.values()].reduce(
      (s, r) => s.plus(r.revenue),
      new Prisma.Decimal(0)
    );
    const totalCogs = [...byProduct.values()].reduce(
      (s, r) => s.plus(r.cogs),
      new Prisma.Decimal(0)
    );
    const totals = grossProfit(totalRevenue, totalCogs);

    res.json({
      rows,
      totals: {
        revenue: Number(totalRevenue.toDecimalPlaces(2)),
        cogs: Number(totalCogs.toDecimalPlaces(2)),
        grossProfit: Number(totals.profit),
        margin: Number(totals.margin),
      },
    });
  })
);
