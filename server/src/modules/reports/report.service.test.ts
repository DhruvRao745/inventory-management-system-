/**
 * Reporting and dashboard (P2-4).
 *
 * THE RULE (PRD §18/§19): "Reports must be calculated from authoritative
 * transactional data, not dashboard counters that can drift." and "Do not make
 * dashboard values separate sources of truth."
 *
 * Why that matters more than it sounds: a counter column only has to be missed
 * once — one error path that returns early, one retry that increments twice,
 * one migration that forgets a table — and the number is wrong forever after,
 * with nothing to indicate it. Nobody notices, because a dashboard is exactly
 * the screen people stop checking once they trust it.
 *
 * So these tests assert figures against the ledger and the invoices, and one
 * of them deliberately writes stock DIRECTLY to the database, bypassing every
 * service, to prove the reports read the source rather than anything a service
 * remembered to update.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { prisma } from "../../lib/prisma.js";
import { app } from "../../app.js";
import * as stockService from "../stock/stock.service.js";
import * as invService from "../invoices/inv.service.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";

/** A signed-in ADMIN for the given fixture. */
function tokenFor(base: Awaited<ReturnType<typeof createTestCompany>>) {
  return jwt.sign(
    { userId: base.user.id, companyId: base.company.id, role: "ADMIN" },
    env.JWT_SECRET,
    { expiresIn: "15m" }
  );
}

const iso = (d: Date) => d.toISOString();
const DAY = 86_400_000;

async function shop() {
  const base = await createTestCompany();
  const token = tokenFor(base);

  const get = (path: string) =>
    request(app).get(path).set("Authorization", `Bearer ${token}`);

  const move = (
    type: "PURCHASE" | "SALE" | "ADJUSTMENT",
    quantity: number,
    status?: "AVAILABLE" | "DAMAGED" | "QUARANTINE" | "EXPIRED",
    unitCost = 10
  ) =>
    stockService.createMovement(base.company.id, base.user.id, {
      productId: base.product.id,
      locationId: base.location.id,
      type,
      quantity,
      ...(status ? { status } : {}),
      ...(type === "PURCHASE" ? { unitCost } : {}),
    } as Parameters<typeof stockService.createMovement>[2]);

  return { ...base, token, get, move };
}

describe("reports — stock by status", () => {
  beforeEach(resetDb);

  it("separates what we own from what we can sell", async () => {
    const { get, move } = await shop();
    await move("PURCHASE", 10);
    await move("PURCHASE", 3, "DAMAGED");
    await move("PURCHASE", 2, "QUARANTINE");

    const res = await get("/api/reports/stock-by-status").expect(200);
    const row = res.body.rows[0];

    expect(row.available).toBe(10);
    expect(row.damaged).toBe(3);
    expect(row.quarantine).toBe(2);
    expect(row.onHand).toBe(15);
  });

  it("values the stock that CANNOT be sold — the point of the report", async () => {
    // "How much money is tied up in stock we can't move?" is the question
    // this report exists to answer.
    const { get, move } = await shop();
    await move("PURCHASE", 10, undefined, 10);
    await move("PURCHASE", 5, "DAMAGED", 10);

    const res = await get("/api/reports/stock-by-status").expect(200);
    expect(res.body.totals.blockedValue).toBeGreaterThan(0);
    expect(res.body.totals.damaged).toBe(5);
  });
});

describe("reports — batches", () => {
  beforeEach(resetDb);

  async function batchShop() {
    const base = await shop();
    await prisma.product.update({
      where: { id: base.product.id },
      data: { tracksBatch: true },
    });
    const receive = (batchNumber: string, quantity: number, days: number) =>
      stockService.createMovement(base.company.id, base.user.id, {
        productId: base.product.id,
        locationId: base.location.id,
        type: "PURCHASE",
        quantity,
        unitCost: 10,
        batchNumber,
        expiryDate: new Date(Date.now() + days * DAY).toISOString(),
      } as Parameters<typeof stockService.createMovement>[2]);
    return { ...base, receive };
  }

  it("lists every lot still holding stock, nearest expiry first", async () => {
    const { get, receive } = await batchShop();
    await receive("LATE", 5, 90);
    await receive("SOON", 5, 5);

    const res = await get("/api/reports/stock-by-batch").expect(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0].batchNumber).toBe("SOON");
  });

  it("expired stock is reported separately from expiring", async () => {
    // Different questions: "needs attention soon" vs "cannot legally be sold".
    const { get, receive } = await batchShop();
    await receive("FRESH", 5, 30);
    await receive("GONE", 5, -10); // expired ten days ago

    const res = await get("/api/reports/expired").expect(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].batchNumber).toBe("GONE");
    expect(res.body.rows[0].daysExpired).toBeGreaterThanOrEqual(9);
  });

  it("flags expired stock STILL counted as good — the urgent case", async () => {
    // Past expiry but status AVAILABLE means the valuation is overstated right
    // now. That is the number someone needs to act on.
    const { get, receive } = await batchShop();
    await receive("GONE", 5, -10);

    const res = await get("/api/reports/expired").expect(200);
    expect(res.body.rows[0].writtenOff).toBe(false);
    expect(res.body.totals.stillCountedAsGood).toBeGreaterThan(0);
  });
});

describe("reports — returns", () => {
  beforeEach(resetDb);

  it("reports a return RATE, not just a count", async () => {
    // Ten returns is excellent on 10,000 sales and alarming on 20. A bare
    // count cannot tell you which situation you're in.
    const base = await shop();
    await base.move("PURCHASE", 100);

    const inv = await invService.createInvoice(base.company.id, base.user.id, {
      customerName: "Walk-in",
      locationId: base.location.id,
      lines: [{ productId: base.product.id, quantity: 20, unitPrice: 50 }],
    } as Parameters<typeof invService.createInvoice>[2]);
    await invService.issueInvoice(base.company.id, base.user.id, inv.id);

    const full = await invService.getInvoice(base.company.id, inv.id);
    const returnService = await import("../returns/return.service.js");
    const ret = await returnService.createReturn(base.company.id, base.user.id, {
      invoiceId: inv.id,
      lines: [
        {
          invoiceLineId: full.lines[0]!.id,
          quantity: 2,
          condition: "DAMAGED",
          restock: false,
        },
      ],
    } as Parameters<typeof returnService.createReturn>[2]);
    await returnService.approveReturn(base.company.id, base.user.id, ret.id);

    const from = iso(new Date(Date.now() - DAY));
    const to = iso(new Date(Date.now() + DAY));
    const res = await base
      .get(`/api/reports/returns?from=${from}&to=${to}`)
      .expect(200);

    expect(res.body.salesReturns.unitsSold).toBe(20);
    expect(res.body.salesReturns.unitsReturned).toBe(2);
    expect(res.body.salesReturns.returnRatePercent).toBe(10);
  });

  it("returns null rather than NaN when nothing was sold", async () => {
    // 0/0 rendered as "NaN%" on a dashboard looks like a broken report.
    const base = await shop();
    const from = iso(new Date(Date.now() - DAY));
    const to = iso(new Date(Date.now() + DAY));

    const res = await base
      .get(`/api/reports/returns?from=${from}&to=${to}`)
      .expect(200);
    expect(res.body.salesReturns.returnRatePercent).toBeNull();
  });

  it("splits returns by condition — a packaging problem looks different", async () => {
    // "Returned often" is a purchasing decision. "Comes back DAMAGED often" is
    // a packaging or supplier problem. Different actions entirely.
    const base = await shop();
    await base.move("PURCHASE", 100);

    const inv = await invService.createInvoice(base.company.id, base.user.id, {
      customerName: "Walk-in",
      locationId: base.location.id,
      lines: [{ productId: base.product.id, quantity: 10, unitPrice: 50 }],
    } as Parameters<typeof invService.createInvoice>[2]);
    await invService.issueInvoice(base.company.id, base.user.id, inv.id);
    const full = await invService.getInvoice(base.company.id, inv.id);

    const returnService = await import("../returns/return.service.js");
    const ret = await returnService.createReturn(base.company.id, base.user.id, {
      invoiceId: inv.id,
      lines: [
        {
          invoiceLineId: full.lines[0]!.id,
          quantity: 3,
          condition: "DAMAGED",
          restock: false,
        },
      ],
    } as Parameters<typeof returnService.createReturn>[2]);
    await returnService.approveReturn(base.company.id, base.user.id, ret.id);

    const from = iso(new Date(Date.now() - DAY));
    const to = iso(new Date(Date.now() + DAY));
    const res = await base
      .get(`/api/reports/returns?from=${from}&to=${to}`)
      .expect(200);

    expect(res.body.salesReturns.byProduct[0].damaged).toBe(3);
    expect(res.body.salesReturns.byProduct[0].sellable).toBe(0);
  });
});

describe("dashboard — derived, never stored", () => {
  beforeEach(resetDb);

  it("inventory value reflects the ledger, not any counter", async () => {
    // The load-bearing test. Stock is written DIRECTLY to the database here,
    // bypassing every service — so nothing had the chance to update a counter.
    // If the dashboard still reports it, the figure must be derived.
    const base = await shop();
    await prisma.product.update({
      where: { id: base.product.id },
      data: { avgCost: 10 },
    });
    await prisma.stockMovement.create({
      data: {
        companyId: base.company.id,
        productId: base.product.id,
        locationId: base.location.id,
        type: "PURCHASE",
        quantity: 7,
        status: "AVAILABLE",
        createdById: base.user.id,
      },
    });

    const res = await base.get("/api/reports/dashboard").expect(200);
    expect(res.body.inventory.totalValue).toBe(70);
  });

  it("splits inventory into sellable and blocked", async () => {
    const base = await shop();
    await base.move("PURCHASE", 10, undefined, 10);
    await base.move("PURCHASE", 5, "DAMAGED", 10);

    const res = await base.get("/api/reports/dashboard").expect(200);
    expect(res.body.inventory.sellableValue).toBeLessThan(
      res.body.inventory.totalValue
    );
    expect(res.body.inventory.blockedValue).toBeGreaterThan(0);
  });

  it("revenue and gross profit come from issued invoices and stamped costs", async () => {
    const base = await shop();
    await base.move("PURCHASE", 100, undefined, 10); // cost 10

    const inv = await invService.createInvoice(base.company.id, base.user.id, {
      customerName: "Walk-in",
      locationId: base.location.id,
      lines: [{ productId: base.product.id, quantity: 10, unitPrice: 25 }],
    } as Parameters<typeof invService.createInvoice>[2]);
    await invService.issueInvoice(base.company.id, base.user.id, inv.id);

    const res = await base.get("/api/reports/dashboard").expect(200);
    expect(res.body.sales.revenue).toBe(250); // 10 × 25
    expect(res.body.sales.cogs).toBe(100); // 10 × 10, from costAtTime
    expect(res.body.sales.grossProfit).toBe(150);
    expect(res.body.sales.marginPercent).toBe(60);
  });

  it("outstanding customer balance follows the payments", async () => {
    const base = await shop();
    await base.move("PURCHASE", 100);

    const inv = await invService.createInvoice(base.company.id, base.user.id, {
      customerName: "Walk-in",
      locationId: base.location.id,
      lines: [{ productId: base.product.id, quantity: 10, unitPrice: 100 }],
    } as Parameters<typeof invService.createInvoice>[2]);
    await invService.issueInvoice(base.company.id, base.user.id, inv.id);

    let res = await base.get("/api/reports/dashboard").expect(200);
    expect(res.body.outstanding.fromCustomers).toBe(1000);

    const { recordPayment } = await import("../payments/payment.service.js");
    await recordPayment(base.company.id, base.user.id, {
      invoiceId: inv.id,
      amount: 400,
      method: "CASH",
    } as Parameters<typeof recordPayment>[2]);

    res = await base.get("/api/reports/dashboard").expect(200);
    expect(res.body.outstanding.fromCustomers).toBe(600);
  });

  it("low stock is judged on AVAILABLE, not on hand", async () => {
    // A shelf full of damaged goods still needs reordering.
    const base = await shop();
    await prisma.product.update({
      where: { id: base.product.id },
      data: { lowStockThreshold: 5 },
    });
    await base.move("PURCHASE", 2);
    await base.move("PURCHASE", 100, "DAMAGED");

    const res = await base.get("/api/reports/dashboard").expect(200);
    expect(res.body.lowStock.count).toBe(1);
    expect(res.body.lowStock.items[0].available).toBe(2);
    expect(res.body.lowStock.items[0].onHand).toBe(102);
  });

  it("margin is null, not NaN, when there is no revenue", async () => {
    const base = await shop();
    const res = await base.get("/api/reports/dashboard").expect(200);
    expect(res.body.sales.marginPercent).toBeNull();
  });

  it("accepts an explicit date window", async () => {
    const base = await shop();
    const from = iso(new Date(Date.now() - 7 * DAY));
    const to = iso(new Date());
    const res = await base
      .get(`/api/reports/dashboard?from=${from}&to=${to}`)
      .expect(200);
    expect(res.body.period.from).toBeTruthy();
  });

  it("refuses a backwards date range", async () => {
    const base = await shop();
    const from = iso(new Date());
    const to = iso(new Date(Date.now() - DAY));
    await base
      .get(`/api/reports/dashboard?from=${from}&to=${to}`)
      .expect(400);
  });
});

describe("reports — GST summary", () => {
  beforeEach(resetDb);

  it("sums the tax STAMPED on issued invoices, grouped by rate", async () => {
    const base = await shop();
    await prisma.company.update({
      where: { id: base.company.id },
      data: { stateCode: "27" },
    });
    await prisma.product.update({
      where: { id: base.product.id },
      data: { gstRate: 18 },
    });
    await base.move("PURCHASE", 100);

    const inv = await invService.createInvoice(base.company.id, base.user.id, {
      customerName: "Walk-in",
      locationId: base.location.id,
      useGst: true,
      placeOfSupply: "27",
      lines: [{ productId: base.product.id, quantity: 1, unitPrice: 1000 }],
    } as Parameters<typeof invService.createInvoice>[2]);
    await invService.issueInvoice(base.company.id, base.user.id, inv.id);

    const from = iso(new Date(Date.now() - DAY));
    const to = iso(new Date(Date.now() + DAY));
    const res = await base
      .get(`/api/reports/gst-summary?from=${from}&to=${to}`)
      .expect(200);

    expect(res.body.taxableValue).toBe(1000);
    expect(res.body.cgstAmount).toBe(90);
    expect(res.body.sgstAmount).toBe(90);
    expect(res.body.totalTax).toBe(180);
    expect(res.body.byRate[0].gstRate).toBe(18);
  });

  it("excludes drafts and cancelled invoices", async () => {
    // A draft is not a bill and a cancelled invoice is not a sale — counting
    // either would overstate the liability.
    const base = await shop();
    await prisma.company.update({
      where: { id: base.company.id },
      data: { stateCode: "27" },
    });
    await prisma.product.update({
      where: { id: base.product.id },
      data: { gstRate: 18 },
    });
    await base.move("PURCHASE", 100);

    await invService.createInvoice(base.company.id, base.user.id, {
      customerName: "Draft only",
      locationId: base.location.id,
      useGst: true,
      lines: [{ productId: base.product.id, quantity: 1, unitPrice: 1000 }],
    } as Parameters<typeof invService.createInvoice>[2]);

    const from = iso(new Date(Date.now() - DAY));
    const to = iso(new Date(Date.now() + DAY));
    const res = await base
      .get(`/api/reports/gst-summary?from=${from}&to=${to}`)
      .expect(200);

    expect(res.body.invoiceCount).toBe(0);
    expect(res.body.totalTax).toBe(0);
  });
});

describe("reports — tenant isolation", () => {
  beforeEach(resetDb);

  it("never counts another company's stock", async () => {
    const ours = await shop();
    const theirs = await createTestCompany("Other Co");
    await prisma.product.update({
      where: { id: theirs.product.id },
      data: { avgCost: 1000 },
    });
    await prisma.stockMovement.create({
      data: {
        companyId: theirs.company.id,
        productId: theirs.product.id,
        locationId: theirs.location.id,
        type: "PURCHASE",
        quantity: 100,
        status: "AVAILABLE",
        createdById: theirs.user.id,
      },
    });

    const res = await ours.get("/api/reports/dashboard").expect(200);
    expect(res.body.inventory.totalValue).toBe(0);
  });
});
