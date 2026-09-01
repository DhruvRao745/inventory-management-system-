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
import { invoiceTotalDecimal } from "../../lib/money.js";
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
      //
      // Routed by taxMode since P2-3. Recomputing a GST invoice here would be
      // the worst place to get it wrong: reported revenue would drift away
      // from the invoices it is supposed to summarise, and the two would never
      // reconcile.
      const invTotal = Number(invoiceTotalDecimal(inv));
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

/* ==================================================================== *
 * P2-4 — the reports PRD §18 required that didn't exist yet             *
 * ==================================================================== */

/**
 * GET /api/reports/stock-by-status
 *   Every shelf, broken down by condition (P2-2).
 *   "How much of what I own can I actually sell?"
 *
 * This is the report that makes statuses worth having. Before it, damaged and
 * quarantined stock existed in the ledger but nothing showed it as a total —
 * so "we own ₹40,000 of inventory" and "we can sell ₹31,000 of inventory" were
 * the same number on screen, and the difference only surfaced when an order
 * couldn't be filled.
 */
reportsRouter.get(
  "/stock-by-status",
  asyncHandler(async (req: AuthRequest, res) => {
    const companyId = req.user!.companyId;

    const grouped = await prisma.stockMovement.groupBy({
      by: ["productId", "status"],
      where: { companyId },
      _sum: { quantity: true },
    });

    const products = await prisma.product.findMany({
      where: { id: { in: grouped.map((g) => g.productId) }, companyId },
      select: { id: true, sku: true, name: true, unit: true, avgCost: true },
    });
    const productById = new Map(products.map((p) => [p.id, p]));

    const zero = new Prisma.Decimal(0);
    type Row = {
      productId: string;
      sku: string;
      name: string;
      unit: string;
      available: Prisma.Decimal;
      damaged: Prisma.Decimal;
      quarantine: Prisma.Decimal;
      expired: Prisma.Decimal;
      onHand: Prisma.Decimal;
      avgCost: Prisma.Decimal;
    };
    const rows = new Map<string, Row>();

    for (const g of grouped) {
      const p = productById.get(g.productId);
      if (!p) continue;
      const qty = g._sum.quantity ?? zero;
      const row: Row = rows.get(g.productId) ?? {
        productId: p.id,
        sku: p.sku,
        name: p.name,
        unit: p.unit,
        available: zero,
        damaged: zero,
        quarantine: zero,
        expired: zero,
        onHand: zero,
        avgCost: p.avgCost,
      };
      const key = g.status.toLowerCase() as
        | "available"
        | "damaged"
        | "quarantine"
        | "expired";
      row[key] = row[key].plus(qty);
      row.onHand = row.onHand.plus(qty);
      rows.set(g.productId, row);
    }

    const out = [...rows.values()]
      .map((r) => ({
        productId: r.productId,
        sku: r.sku,
        name: r.name,
        unit: r.unit,
        available: Number(r.available),
        damaged: Number(r.damaged),
        quarantine: Number(r.quarantine),
        expired: Number(r.expired),
        onHand: Number(r.onHand),
        // Value the UNSELLABLE portion. This is the number that answers "how
        // much money is tied up in stock we can't move?" — which is the whole
        // reason anyone runs this report.
        blockedValue: Number(
          r.damaged
            .plus(r.quarantine)
            .plus(r.expired)
            .times(r.avgCost)
            .toDecimalPlaces(2)
        ),
      }))
      // Worst problem first: most money stuck, not most units.
      .sort((a, b) => b.blockedValue - a.blockedValue);

    const totals = out.reduce(
      (acc, r) => ({
        available: acc.available + r.available,
        damaged: acc.damaged + r.damaged,
        quarantine: acc.quarantine + r.quarantine,
        expired: acc.expired + r.expired,
        blockedValue:
          Math.round((acc.blockedValue + r.blockedValue) * 100) / 100,
      }),
      { available: 0, damaged: 0, quarantine: 0, expired: 0, blockedValue: 0 }
    );

    res.json({ rows: out, totals });
  })
);

/**
 * GET /api/reports/stock-by-batch?locationId&productId
 *   Every lot with stock left, newest expiry last.
 *   "Which specific batches am I holding, and where?"
 *
 * Separate from /expiring because the questions differ: expiring asks "what
 * needs attention soon", this asks "what exactly is on the shelf" — the report
 * you take with you when counting, or reach for during a product recall.
 */
reportsRouter.get(
  "/stock-by-batch",
  asyncHandler(async (req: AuthRequest, res) => {
    const q = z
      .object({
        locationId: z.string().optional(),
        productId: z.string().optional(),
      })
      .parse(req.query);
    const companyId = req.user!.companyId;

    const batches = await prisma.inventoryBatch.findMany({
      where: {
        companyId,
        remainingQuantity: { gt: 0 },
        ...(q.locationId ? { locationId: q.locationId } : {}),
        ...(q.productId ? { productId: q.productId } : {}),
      },
      include: {
        product: { select: { id: true, sku: true, name: true, unit: true } },
        location: { select: { id: true, name: true } },
      },
      // NULLS LAST matters: a lot with no expiry is not "expiring first".
      orderBy: [{ expiryDate: { sort: "asc", nulls: "last" } }, { batchNumber: "asc" }],
    });

    const rows = batches.map((b) => ({
      batchId: b.id,
      batchNumber: b.batchNumber,
      status: b.status,
      product: b.product,
      location: b.location,
      manufactureDate: b.manufactureDate,
      expiryDate: b.expiryDate,
      receivedQuantity: Number(b.receivedQuantity),
      remainingQuantity: Number(b.remainingQuantity),
      unitCost: Number(b.unitCost),
      value: Number(b.remainingQuantity.times(b.unitCost).toDecimalPlaces(2)),
    }));

    res.json({
      rows,
      totals: {
        batches: rows.length,
        value: Math.round(rows.reduce((s, r) => s + r.value, 0) * 100) / 100,
      },
    });
  })
);

/**
 * GET /api/reports/expired
 *   Batches whose expiry has already passed but which still hold stock.
 *   "What is sitting on my shelves that I legally cannot sell?"
 *
 * Deliberately separate from /expiring, and deliberately NOT automatic: per
 * the P2-2 decision, nothing reclassifies stock to EXPIRED on a schedule. A
 * background job silently writing off inventory at 3am is the kind of thing
 * that confuses everyone the next morning. This report surfaces it; a person
 * decides.
 */
reportsRouter.get(
  "/expired",
  asyncHandler(async (req: AuthRequest, res) => {
    const companyId = req.user!.companyId;
    const now = new Date();

    const batches = await prisma.inventoryBatch.findMany({
      where: {
        companyId,
        remainingQuantity: { gt: 0 },
        expiryDate: { lt: now },
      },
      include: {
        product: { select: { id: true, sku: true, name: true, unit: true } },
        location: { select: { id: true, name: true } },
      },
      orderBy: { expiryDate: "asc" }, // longest expired first — the worst
    });

    const rows = batches.map((b) => ({
      batchId: b.id,
      batchNumber: b.batchNumber,
      status: b.status,
      product: b.product,
      location: b.location,
      expiryDate: b.expiryDate,
      daysExpired: b.expiryDate
        ? Math.floor((now.getTime() - b.expiryDate.getTime()) / 86_400_000)
        : 0,
      remainingQuantity: Number(b.remainingQuantity),
      value: Number(b.remainingQuantity.times(b.unitCost).toDecimalPlaces(2)),
      // Already written off, or still counted as good stock? The second is the
      // urgent case — it means the valuation is currently overstated.
      writtenOff: b.status === "EXPIRED",
    }));

    res.json({
      rows,
      totals: {
        batches: rows.length,
        value: Math.round(rows.reduce((s, r) => s + r.value, 0) * 100) / 100,
        stillCountedAsGood:
          Math.round(
            rows.filter((r) => !r.writtenOff).reduce((s, r) => s + r.value, 0) *
              100
          ) / 100,
      },
    });
  })
);

/**
 * GET /api/reports/returns?from&to
 *   Sales returns and supplier returns over a period.
 *   "What is coming back, and why?"
 *
 * Return rate is the number that matters here — an absolute count of returns
 * means nothing without the sales it is measured against. Ten returns is
 * excellent on 10,000 sales and alarming on 20.
 */
reportsRouter.get(
  "/returns",
  asyncHandler(async (req: AuthRequest, res) => {
    const { from, to } = dateRangeSchema.parse(req.query);
    const companyId = req.user!.companyId;
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (fromDate > toDate) throw new AppError(400, "'from' is after 'to'");

    const range = { gte: fromDate, lte: toDate };

    const [salesReturns, supplierReturns, soldUnits] = await Promise.all([
      prisma.salesReturn.findMany({
        where: { companyId, createdAt: range },
        include: {
          lines: {
            include: {
              product: { select: { id: true, sku: true, name: true, unit: true } },
            },
          },
        },
      }),
      prisma.supplierReturn.findMany({
        where: { companyId, createdAt: range },
        include: {
          supplier: { select: { id: true, name: true } },
          lines: true,
        },
      }),
      // Units SOLD in the same window — the denominator for the rate.
      prisma.stockMovement.aggregate({
        where: { companyId, type: "SALE", createdAt: range },
        _sum: { quantity: true },
      }),
    ]);

    const zero = new Prisma.Decimal(0);

    // Which products come back most, and in what condition. "Product X is
    // returned often" is a purchasing decision; "Product X comes back DAMAGED
    // often" is a packaging or supplier problem. Different actions.
    const byProduct = new Map<
      string,
      {
        productId: string;
        sku: string;
        name: string;
        unit: string;
        sellable: Prisma.Decimal;
        damaged: Prisma.Decimal;
        quarantine: Prisma.Decimal;
        total: Prisma.Decimal;
      }
    >();

    for (const ret of salesReturns) {
      // Cancelled returns never happened — counting them would inflate the
      // rate with paperwork that was withdrawn.
      if (ret.status === "CANCELLED") continue;
      for (const line of ret.lines) {
        const row = byProduct.get(line.productId) ?? {
          productId: line.productId,
          sku: line.product.sku,
          name: line.product.name,
          unit: line.product.unit,
          sellable: zero,
          damaged: zero,
          quarantine: zero,
          total: zero,
        };
        const key = line.condition.toLowerCase() as
          | "sellable"
          | "damaged"
          | "quarantine";
        row[key] = row[key].plus(line.quantity);
        row.total = row.total.plus(line.quantity);
        byProduct.set(line.productId, row);
      }
    }

    const returnedUnits = [...byProduct.values()].reduce(
      (s, r) => s.plus(r.total),
      zero
    );
    // SALE movements are negative — take the absolute value for the ratio.
    const sold = (soldUnits._sum.quantity ?? zero).abs();

    const refunded = salesReturns
      .filter((r) => r.status === "REFUNDED")
      .reduce((s, r) => s.plus(r.refundAmount ?? zero), zero);

    res.json({
      salesReturns: {
        count: salesReturns.filter((r) => r.status !== "CANCELLED").length,
        cancelled: salesReturns.filter((r) => r.status === "CANCELLED").length,
        unitsReturned: Number(returnedUnits),
        unitsSold: Number(sold),
        // Guarded: a period with no sales has no meaningful rate, and 0/0
        // rendered as "NaN%" on a dashboard looks like a broken report.
        returnRatePercent: sold.isZero()
          ? null
          : Number(returnedUnits.dividedBy(sold).times(100).toDecimalPlaces(2)),
        refundedAmount: Number(refunded.toDecimalPlaces(2)),
        byProduct: [...byProduct.values()]
          .map((r) => ({
            productId: r.productId,
            sku: r.sku,
            name: r.name,
            unit: r.unit,
            sellable: Number(r.sellable),
            damaged: Number(r.damaged),
            quarantine: Number(r.quarantine),
            total: Number(r.total),
          }))
          .sort((a, b) => b.total - a.total),
      },
      supplierReturns: {
        count: supplierReturns.filter((r) => r.status !== "CANCELLED").length,
        unitsReturned: Number(
          supplierReturns
            .filter((r) => r.status !== "CANCELLED")
            .flatMap((r) => r.lines)
            .reduce((s, l) => s.plus(l.quantity), zero)
        ),
        bySupplier: Object.values(
          supplierReturns
            .filter((r) => r.status !== "CANCELLED")
            .reduce<
              Record<
                string,
                { supplierId: string; name: string; returns: number; units: number }
              >
            >((acc, r) => {
              const row = acc[r.supplierId] ?? {
                supplierId: r.supplierId,
                name: r.supplier.name,
                returns: 0,
                units: 0,
              };
              row.returns += 1;
              row.units += Number(
                r.lines.reduce((s, l) => s.plus(l.quantity), zero)
              );
              acc[r.supplierId] = row;
              return acc;
            }, {})
        ).sort((a, b) => b.units - a.units),
      },
    });
  })
);

/**
 * GET /api/reports/gst-summary?from&to
 *   Taxable value and tax collected, grouped by rate slab (P2-3).
 *   "What do I owe, and under which heads?"
 *
 * Built ENTIRELY from the tax stamped on invoice lines — never recomputed from
 * today's rates. A filing summary that disagreed with the invoices it
 * summarises would be worse than no summary at all.
 */
reportsRouter.get(
  "/gst-summary",
  asyncHandler(async (req: AuthRequest, res) => {
    const { from, to } = dateRangeSchema.parse(req.query);
    const companyId = req.user!.companyId;
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (fromDate > toDate) throw new AppError(400, "'from' is after 'to'");

    const invoices = await prisma.invoice.findMany({
      where: {
        companyId,
        taxMode: "GST",
        // Only ISSUED and PAID. A draft is not a bill and a cancelled invoice
        // is not a sale — including either would overstate the liability.
        status: { in: ["ISSUED", "PAID"] },
        issuedAt: { gte: fromDate, lte: toDate },
      },
      include: { lines: true },
    });

    const zero = new Prisma.Decimal(0);
    const byRate = new Map<
      string,
      {
        gstRate: Prisma.Decimal;
        taxableValue: Prisma.Decimal;
        cgstAmount: Prisma.Decimal;
        sgstAmount: Prisma.Decimal;
        igstAmount: Prisma.Decimal;
      }
    >();

    let taxableValue = zero;
    let cgstAmount = zero;
    let sgstAmount = zero;
    let igstAmount = zero;

    for (const inv of invoices) {
      for (const l of inv.lines) {
        const rate = l.gstRate ?? zero;
        const t = l.taxableValue ?? zero;
        const c = l.cgstAmount ?? zero;
        const s = l.sgstAmount ?? zero;
        const i = l.igstAmount ?? zero;

        taxableValue = taxableValue.plus(t);
        cgstAmount = cgstAmount.plus(c);
        sgstAmount = sgstAmount.plus(s);
        igstAmount = igstAmount.plus(i);

        const key = rate.toString();
        const row = byRate.get(key) ?? {
          gstRate: rate,
          taxableValue: zero,
          cgstAmount: zero,
          sgstAmount: zero,
          igstAmount: zero,
        };
        byRate.set(key, {
          gstRate: rate,
          taxableValue: row.taxableValue.plus(t),
          cgstAmount: row.cgstAmount.plus(c),
          sgstAmount: row.sgstAmount.plus(s),
          igstAmount: row.igstAmount.plus(i),
        });
      }
    }

    res.json({
      invoiceCount: invoices.length,
      taxableValue: Number(taxableValue.toDecimalPlaces(2)),
      cgstAmount: Number(cgstAmount.toDecimalPlaces(2)),
      sgstAmount: Number(sgstAmount.toDecimalPlaces(2)),
      igstAmount: Number(igstAmount.toDecimalPlaces(2)),
      totalTax: Number(
        cgstAmount.plus(sgstAmount).plus(igstAmount).toDecimalPlaces(2)
      ),
      byRate: [...byRate.values()]
        .sort((a, b) => a.gstRate.comparedTo(b.gstRate))
        .map((r) => ({
          gstRate: Number(r.gstRate),
          taxableValue: Number(r.taxableValue.toDecimalPlaces(2)),
          cgstAmount: Number(r.cgstAmount.toDecimalPlaces(2)),
          sgstAmount: Number(r.sgstAmount.toDecimalPlaces(2)),
          igstAmount: Number(r.igstAmount.toDecimalPlaces(2)),
        })),
      // Stated plainly so nobody mistakes this for a filing-ready return.
      note: "Summary of tax stamped on issued invoices. Not a GST return.",
    });
  })
);

/**
 * GET /api/reports/dashboard?from&to
 *   Every headline figure in one call (PRD §19).
 *
 * THE RULE THIS OBEYS: "Do not make dashboard values separate sources of
 * truth. Dashboard metrics should derive from transactional/reporting queries."
 *
 * Every number below is computed here, now, from movements, invoices and
 * payments. Nothing is read from a counter column that something else has to
 * remember to update. Counters drift — a missed increment during an error
 * path, a retry that double-counts, a migration that forgets one — and a
 * dashboard that drifts is worse than one that is slow, because people keep
 * believing it long after it stopped being true.
 *
 * The cost is that this endpoint does real work. That is the right trade for a
 * screen loaded a few times a day.
 */
reportsRouter.get(
  "/dashboard",
  asyncHandler(async (req: AuthRequest, res) => {
    const q = z
      .object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        tzOffset: z.coerce.number().int().default(0),
      })
      .parse(req.query);

    const companyId = req.user!.companyId;
    const now = new Date();

    // Default window: today in the USER's timezone, not the server's. A shop
    // in Mumbai closing at 9pm must not see its evening sales land on
    // "tomorrow" because the server thinks in UTC.
    const localNow = new Date(now.getTime() - q.tzOffset * 60_000);
    const localMidnight = new Date(
      Date.UTC(
        localNow.getUTCFullYear(),
        localNow.getUTCMonth(),
        localNow.getUTCDate()
      )
    );
    const fromDate = q.from
      ? new Date(q.from)
      : new Date(localMidnight.getTime() + q.tzOffset * 60_000);
    const toDate = q.to ? new Date(q.to) : now;
    if (fromDate > toDate) throw new AppError(400, "'from' is after 'to'");

    const range = { gte: fromDate, lte: toDate };
    const zero = new Prisma.Decimal(0);

    const [
      stockByStatus,
      products,
      periodInvoices,
      openInvoices,
      openPOs,
      expiringBatches,
      soldInPeriod,
    ] = await Promise.all([
      // Inventory value: every condition, because we own damaged stock too.
      prisma.stockMovement.groupBy({
        by: ["productId", "status"],
        where: { companyId },
        _sum: { quantity: true },
      }),
      prisma.product.findMany({
        where: { companyId },
        select: {
          id: true,
          sku: true,
          name: true,
          unit: true,
          avgCost: true,
          isActive: true,
          lowStockThreshold: true,
        },
      }),
      // Revenue for the window, from the invoices themselves.
      prisma.invoice.findMany({
        where: {
          companyId,
          status: { in: ["ISSUED", "PAID"] },
          issuedAt: range,
        },
        include: { lines: true },
      }),
      // Outstanding customer money: unpaid balances on issued invoices.
      prisma.invoice.findMany({
        where: { companyId, status: { in: ["ISSUED", "PAID"] } },
        include: { lines: true, payments: { select: { amount: true } } },
      }),
      // Outstanding supplier money: ordered but not yet received.
      prisma.purchaseOrder.findMany({
        where: { companyId, status: { in: ["ORDERED", "PARTIAL"] } },
        include: { lines: true },
      }),
      prisma.inventoryBatch.findMany({
        where: {
          companyId,
          remainingQuantity: { gt: 0 },
          expiryDate: {
            not: null,
            lte: new Date(now.getTime() + 30 * 86_400_000),
          },
        },
        include: {
          product: { select: { id: true, sku: true, name: true, unit: true } },
        },
        orderBy: { expiryDate: "asc" },
        take: 10,
      }),
      // Units sold + COGS for the window, from the ledger's stamped costs.
      prisma.stockMovement.findMany({
        where: { companyId, type: "SALE", createdAt: range },
        select: { productId: true, quantity: true, costAtTime: true },
      }),
    ]);

    const productById = new Map(products.map((p) => [p.id, p]));

    // --- inventory value, split by what can actually be sold -------------
    let inventoryValue = zero;
    let sellableValue = zero;
    const onHandByProduct = new Map<string, Prisma.Decimal>();
    const availableByProduct = new Map<string, Prisma.Decimal>();

    for (const g of stockByStatus) {
      const p = productById.get(g.productId);
      if (!p) continue;
      const qty = g._sum.quantity ?? zero;
      const value = qty.times(p.avgCost);
      inventoryValue = inventoryValue.plus(value);
      onHandByProduct.set(
        g.productId,
        (onHandByProduct.get(g.productId) ?? zero).plus(qty)
      );
      if (g.status === "AVAILABLE") {
        sellableValue = sellableValue.plus(value);
        availableByProduct.set(
          g.productId,
          (availableByProduct.get(g.productId) ?? zero).plus(qty)
        );
      }
    }

    // --- revenue, COGS, gross profit ------------------------------------
    const revenue = periodInvoices.reduce(
      (s, inv) => s.plus(invoiceTotalDecimal(inv)),
      zero
    );

    // COGS from costAtTime — the cost stamped on each sale when it happened,
    // not today's average. This is what keeps March's profit fixed after an
    // expensive April delivery (P1-3).
    const cogs = soldInPeriod.reduce(
      (s, m) => s.plus(m.quantity.abs().times(m.costAtTime ?? zero)),
      zero
    );

    // --- outstanding customer balance ------------------------------------
    let outstandingCustomer = zero;
    for (const inv of openInvoices) {
      const total = invoiceTotalDecimal(inv);
      const paid = inv.payments.reduce((s, p) => s.plus(p.amount), zero);
      const balance = total.minus(paid);
      if (balance.greaterThan(0)) outstandingCustomer = outstandingCustomer.plus(balance);
    }

    // --- outstanding supplier balance ------------------------------------
    // What's been ordered and not yet received, valued at the agreed price.
    let outstandingSupplier = zero;
    for (const po of openPOs) {
      for (const line of po.lines) {
        const pending = line.quantity.minus(line.receivedQty ?? zero);
        if (pending.greaterThan(0)) {
          outstandingSupplier = outstandingSupplier.plus(
            pending.times(line.unitCost)
          );
        }
      }
    }

    // --- low stock, judged on AVAILABLE (P2-1/P2-2) ----------------------
    const lowStock = products
      .filter((p) => {
        if (!p.isActive) return false;
        if (p.lowStockThreshold.lessThanOrEqualTo(0)) return false;
        const available = availableByProduct.get(p.id) ?? zero;
        return available.lessThanOrEqualTo(p.lowStockThreshold);
      })
      .map((p) => ({
        productId: p.id,
        sku: p.sku,
        name: p.name,
        unit: p.unit,
        available: Number(availableByProduct.get(p.id) ?? zero),
        onHand: Number(onHandByProduct.get(p.id) ?? zero),
        threshold: Number(p.lowStockThreshold),
      }))
      .sort((a, b) => a.available - b.available); // emptiest first

    // --- top sellers in the window ---------------------------------------
    const soldByProduct = new Map<string, Prisma.Decimal>();
    for (const m of soldInPeriod) {
      soldByProduct.set(
        m.productId,
        (soldByProduct.get(m.productId) ?? zero).plus(m.quantity.abs())
      );
    }
    const topProducts = [...soldByProduct.entries()]
      .map(([productId, units]) => {
        const p = productById.get(productId);
        return p
          ? {
              productId,
              sku: p.sku,
              name: p.name,
              unit: p.unit,
              unitsSold: Number(units),
            }
          : null;
      })
      .filter((r) => r !== null)
      .sort((a, b) => b!.unitsSold - a!.unitsSold)
      .slice(0, 5);

    const grossProfitValue = revenue.minus(cogs);

    res.json({
      period: { from: fromDate, to: toDate },
      inventory: {
        // Two figures on purpose: what we own, and what we could sell. They
        // used to be one number, which hid every damaged and reserved unit.
        totalValue: Number(inventoryValue.toDecimalPlaces(2)),
        sellableValue: Number(sellableValue.toDecimalPlaces(2)),
        blockedValue: Number(
          inventoryValue.minus(sellableValue).toDecimalPlaces(2)
        ),
      },
      sales: {
        revenue: Number(revenue.toDecimalPlaces(2)),
        invoices: periodInvoices.length,
        cogs: Number(cogs.toDecimalPlaces(2)),
        grossProfit: Number(grossProfitValue.toDecimalPlaces(2)),
        marginPercent: revenue.isZero()
          ? null
          : Number(
              grossProfitValue.dividedBy(revenue).times(100).toDecimalPlaces(2)
            ),
      },
      outstanding: {
        fromCustomers: Number(outstandingCustomer.toDecimalPlaces(2)),
        toSuppliers: Number(outstandingSupplier.toDecimalPlaces(2)),
      },
      lowStock: { count: lowStock.length, items: lowStock.slice(0, 10) },
      expiringBatches: expiringBatches.map((b) => ({
        batchId: b.id,
        batchNumber: b.batchNumber,
        product: b.product,
        expiryDate: b.expiryDate,
        remainingQuantity: Number(b.remainingQuantity),
        daysLeft: b.expiryDate
          ? Math.ceil((b.expiryDate.getTime() - now.getTime()) / 86_400_000)
          : null,
      })),
      topProducts,
    });
  })
);
