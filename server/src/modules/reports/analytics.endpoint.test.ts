/**
 * Analytics endpoints (P3-2) — the parts that need real data.
 *
 * lib/analytics.test.ts covers the formulas. This covers what feeds them,
 * which is where the harder decision lives: turnover needs stock value AT A
 * PAST DATE, and the only honest source for that is the ledger.
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

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString();

async function shop() {
  const base = await createTestCompany();
  const token = jwt.sign(
    { userId: base.user.id, companyId: base.company.id, role: "ADMIN" },
    env.JWT_SECRET,
    { expiresIn: "15m" }
  );
  const get = (path: string) =>
    request(app).get(path).set("Authorization", `Bearer ${token}`);

  const buy = (quantity: number, unitCost = 10) =>
    stockService.createMovement(base.company.id, base.user.id, {
      productId: base.product.id,
      locationId: base.location.id,
      type: "PURCHASE",
      quantity,
      unitCost,
    } as Parameters<typeof stockService.createMovement>[2]);

  const sell = async (quantity: number, unitPrice = 25) => {
    const inv = await invService.createInvoice(base.company.id, base.user.id, {
      customerName: "Walk-in",
      locationId: base.location.id,
      lines: [{ productId: base.product.id, quantity, unitPrice }],
    } as Parameters<typeof invService.createInvoice>[2]);
    await invService.issueInvoice(base.company.id, base.user.id, inv.id);
    return inv;
  };

  return { ...base, token, get, buy, sell };
}

describe("turnover — reconstructed from the ledger", () => {
  beforeEach(resetDb);

  it("computes COGS from the cost stamped on each sale", async () => {
    const s = await shop();
    await s.buy(100, 10);
    await s.sell(20);

    const from = iso(new Date(Date.now() - DAY));
    const to = iso(new Date(Date.now() + DAY));
    const res = await s.get(`/api/reports/turnover?from=${from}&to=${to}`).expect(200);

    expect(res.body.cogs).toBe(200); // 20 units × ₹10 stamped at sale time
  });

  it("values opening stock from movements up to that date, not today", async () => {
    // The whole reason this endpoint reconstructs rather than reading
    // stockValue: at the START of the window there was nothing on the shelf.
    // Using today's value as the denominator would silently overstate it.
    const s = await shop();
    await s.buy(100, 10);

    // Window starting BEFORE any stock existed.
    const from = iso(new Date(Date.now() - 10 * DAY));
    const to = iso(new Date(Date.now() + DAY));
    const res = await s.get(`/api/reports/turnover?from=${from}&to=${to}`).expect(200);

    expect(res.body.openingValue).toBe(0); // nothing had been bought yet
    expect(res.body.closingValue).toBeGreaterThan(0);
  });

  it("returns a null ratio rather than zero when nothing was held", async () => {
    const s = await shop();
    const from = iso(new Date(Date.now() - DAY));
    const to = iso(new Date(Date.now() + DAY));
    const res = await s.get(`/api/reports/turnover?from=${from}&to=${to}`).expect(200);

    expect(res.body.ratio).toBeNull();
  });

  it("counts sales whose cost was never recorded", async () => {
    // Legacy stock has no cost history, so its sales stamp a zero cost. The
    // endpoint has to COUNT those, because a COGS of zero from unpriced sales
    // and a COGS of zero from no sales are indistinguishable downstream — and
    // reporting the second when it's the first tells the user their stock
    // never moved.
    //
    // The sequence mirrors the real one: goods arrive with no cost recorded,
    // they sell (stamping a zero cost, permanently — PRD §7 forbids rewriting
    // it), and only later does someone establish an opening cost via the
    // backfill. So the stock has a value today while the past sales do not.
    const s = await shop();
    await s.buy(100, 0); // received with no cost, exactly like pre-P1-3 stock
    await s.sell(20);
    await prisma.product.update({
      where: { id: s.product.id },
      data: { avgCost: 10, stockValue: 800 }, // the backfill, after the fact
    });

    const from = iso(new Date(Date.now() - DAY));
    const to = iso(new Date(Date.now() + DAY));
    const res = await s.get(`/api/reports/turnover?from=${from}&to=${to}`).expect(200);

    expect(res.body.salesCount).toBe(1);
    expect(res.body.salesMissingCost).toBe(1);
    expect(res.body.ratio).toBeNull(); // NOT 0
    expect(res.body.unavailableReason).toMatch(/cost/i);
  });

  it("does not call a full warehouse empty just because it has no cost", async () => {
    // The variant of the above where the backfill has NOT been run: stock is
    // on the shelf, none of it is priced, so the stock VALUE is zero. Reading
    // that as "no stock was held" is a plain falsehood, and it is the reading
    // an untended `average <= 0` branch gives you.
    const s = await shop();
    await s.buy(100, 0);

    const from = iso(new Date(Date.now() - DAY));
    const to = iso(new Date(Date.now() + DAY));
    const res = await s.get(`/api/reports/turnover?from=${from}&to=${to}`).expect(200);

    expect(res.body.ratio).toBeNull();
    expect(res.body.unavailableReason).toMatch(/recorded cost/i);
    expect(res.body.unavailableReason).not.toMatch(/no stock was held/i);
  });

  it("states its own approximation rather than hiding it", async () => {
    // Historical quantities valued at today's average cost. Fine for a ratio,
    // not for a balance sheet — and the response says so.
    const s = await shop();
    await s.buy(10);
    const from = iso(new Date(Date.now() - DAY));
    const to = iso(new Date(Date.now() + DAY));
    const res = await s.get(`/api/reports/turnover?from=${from}&to=${to}`).expect(200);

    expect(res.body.note).toMatch(/balance sheet/i);
  });
});

describe("dead stock", () => {
  beforeEach(resetDb);

  it("finds stock that has never sold at all", async () => {
    const s = await shop();
    await s.buy(50);

    const res = await s.get("/api/reports/dead-stock").expect(200);
    const row = res.body.rows.find(
      (r: { productId: string }) => r.productId === s.product.id
    );
    expect(row.staleness).toBe("dead");
    expect(row.daysSinceLastSale).toBeNull();
  });

  it("reports the money tied up, which is what makes it actionable", async () => {
    const s = await shop();
    await s.buy(50, 10);

    const res = await s.get("/api/reports/dead-stock").expect(200);
    expect(res.body.totals.tiedUpValue).toBe(500); // 50 × ₹10
  });

  it("leaves selling products alone", async () => {
    const s = await shop();
    await s.buy(100);
    await s.sell(5); // sold today

    const res = await s.get("/api/reports/dead-stock").expect(200);
    expect(
      res.body.rows.find(
        (r: { productId: string }) => r.productId === s.product.id
      )
    ).toBeUndefined();
  });

  it("ignores products with no stock — absent isn't dead", async () => {
    const s = await shop(); // product exists, never stocked
    const res = await s.get("/api/reports/dead-stock").expect(200);
    expect(res.body.rows).toHaveLength(0);
  });

  it("says how much stock is held, so an empty result isn't ambiguous", async () => {
    // "Everything you hold is selling" and "you hold nothing" both give zero
    // rows. Without a count the caller can't tell which, and will pick the
    // reassuring one.
    const empty = await shop();
    const r1 = await empty.get("/api/reports/dead-stock").expect(200);
    expect(r1.body.totals.productsHeld).toBe(0);

    const stocked = await shop();
    await stocked.buy(100);
    await stocked.sell(5); // selling, so it produces no rows
    const r2 = await stocked.get("/api/reports/dead-stock").expect(200);
    expect(r2.body.rows).toHaveLength(0);
    expect(r2.body.totals.productsHeld).toBe(1);
  });

  it("accepts custom thresholds", async () => {
    const s = await shop();
    await s.buy(10);
    const res = await s
      .get("/api/reports/dead-stock?slowAfterDays=1&staleAfterDays=2")
      .expect(200);
    expect(res.body.thresholds.slowAfterDays).toBe(1);
  });
});

describe("ABC", () => {
  beforeEach(resetDb);

  it("ranks by revenue from invoice lines, not by stock movements", async () => {
    // A movement knows what stock COST, not what it sold for. Revenue has to
    // come from the invoice.
    const s = await shop();
    await s.buy(100);
    await s.sell(4, 50); // ₹200 of revenue

    const from = iso(new Date(Date.now() - DAY));
    const to = iso(new Date(Date.now() + DAY));
    const res = await s.get(`/api/reports/abc?from=${from}&to=${to}`).expect(200);

    expect(res.body.total).toBe(200);
    expect(res.body.rows[0].id).toBe(s.product.id);
  });

  it("declines to classify a small catalogue", async () => {
    const s = await shop();
    await s.buy(100);
    await s.sell(1);

    const from = iso(new Date(Date.now() - DAY));
    const to = iso(new Date(Date.now() + DAY));
    const res = await s.get(`/api/reports/abc?from=${from}&to=${to}`).expect(200);

    expect(res.body.classified).toBe(false);
    expect(res.body.note).toMatch(/at least/i);
  });

  it("can rank by quantity instead", async () => {
    const s = await shop();
    await s.buy(100);
    await s.sell(7, 50);

    const from = iso(new Date(Date.now() - DAY));
    const to = iso(new Date(Date.now() + DAY));
    const res = await s
      .get(`/api/reports/abc?from=${from}&to=${to}&basis=quantity`)
      .expect(200);

    expect(res.body.basis).toBe("quantity");
    expect(res.body.total).toBe(7);
  });
});

describe("trends", () => {
  beforeEach(resetDb);

  it("returns a point for every day, including days with no sales", async () => {
    // A gap is a real zero. Dropping empty days would flatter the trend by
    // hiding the days nothing sold.
    const s = await shop();
    await s.buy(100);
    await s.sell(5);

    const from = iso(new Date(Date.now() - 6 * DAY));
    const to = iso(new Date());
    const res = await s.get(`/api/reports/trends?from=${from}&to=${to}`).expect(200);

    expect(res.body.series.length).toBeGreaterThanOrEqual(6);
    expect(res.body.series.some((d: { units: number }) => d.units === 0)).toBe(
      true
    );
  });

  it("reports unknown rather than guessing from a short window", async () => {
    const s = await shop();
    await s.buy(100);
    await s.sell(5);

    const from = iso(new Date(Date.now() - 2 * DAY));
    const to = iso(new Date());
    const res = await s.get(`/api/reports/trends?from=${from}&to=${to}`).expect(200);

    expect(res.body.demandTrend.direction).toBe("unknown");
  });

  it("refuses a backwards range", async () => {
    const s = await shop();
    const from = iso(new Date());
    const to = iso(new Date(Date.now() - DAY));
    await s.get(`/api/reports/trends?from=${from}&to=${to}`).expect(400);
  });
});

describe("analytics — tenant isolation", () => {
  beforeEach(resetDb);

  it("never counts another company's stock as dead", async () => {
    const ours = await shop();
    const theirs = await createTestCompany("Other Co");
    await stockService.createMovement(theirs.company.id, theirs.user.id, {
      productId: theirs.product.id,
      locationId: theirs.location.id,
      type: "PURCHASE",
      quantity: 999,
      unitCost: 10,
    } as Parameters<typeof stockService.createMovement>[2]);

    const res = await ours.get("/api/reports/dead-stock").expect(200);
    expect(res.body.rows).toHaveLength(0);
  });
});
