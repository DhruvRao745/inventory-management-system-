/**
 * Forecast endpoint (P3-3).
 *
 * lib/forecast.test.ts covers the maths. This covers what feeds it and — more
 * importantly — what it must never do.
 *
 * The spec is one sentence: "Forecasting is advisory only; it must never
 * directly modify stock or create orders." A comment saying so is worth
 * nothing; the first test below counts rows before and after.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { prisma } from "../../lib/prisma.js";
import { app } from "../../app.js";
import * as stockService from "../stock/stock.service.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";

const DAY = 86_400_000;

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

  /**
   * A sale written directly at a chosen date.
   *
   * The service stamps `createdAt` itself, and a forecast is entirely about
   * WHEN things sold — so the history has to be backdated afterwards. Done
   * through the service first so the ledger stays consistent, then the one
   * field is moved.
   *
   * Quantity is POSITIVE. `createMovement` derives the sign from the type
   * (SALE deducts), and passing a negative is rejected outright — only
   * ADJUSTMENT may arrive already signed.
   */
  const sellOn = async (daysAgo: number, quantity: number) => {
    const m = await stockService.createMovement(base.company.id, base.user.id, {
      productId: base.product.id,
      locationId: base.location.id,
      type: "SALE",
      quantity,
    } as Parameters<typeof stockService.createMovement>[2]);
    await prisma.stockMovement.update({
      where: { id: m.id },
      data: { createdAt: new Date(Date.now() - daysAgo * DAY) },
    });
  };

  /** Steady demand across the window, so the forecast has something to work on. */
  const sellSteadily = async (days: number, perDay: number) => {
    for (let d = 1; d <= days; d++) await sellOn(d, perDay);
  };

  return { ...base, token, get, buy, sellOn, sellSteadily };
}

type ForecastRow = {
  productId: string;
  available: number;
  daysOfCover: number | null;
  forecast: {
    predictedDemand: number | null;
    perDay: number | null;
    confidence: string | null;
    unavailableReason: string | null;
  };
  suggestion: { suggestedQty: number | null; reason: string };
};

const rowFor = (body: { rows: ForecastRow[] }, productId: string) =>
  body.rows.find((r) => r.productId === productId)!;

describe("forecast — it must not act", () => {
  beforeEach(resetDb);

  it("writes nothing: no movements, no orders, no invoices", async () => {
    // THE constraint, checked rather than asserted in a comment.
    const s = await shop();
    await s.buy(500);
    await s.sellSteadily(60, 2);

    const before = {
      movements: await prisma.stockMovement.count(),
      orders: await prisma.purchaseOrder.count(),
      invoices: await prisma.invoice.count(),
      products: await prisma.product.count(),
    };

    await s.get("/api/reports/forecast").expect(200);
    await s.get("/api/reports/forecast?horizonDays=90").expect(200);

    expect({
      movements: await prisma.stockMovement.count(),
      orders: await prisma.purchaseOrder.count(),
      invoices: await prisma.invoice.count(),
      products: await prisma.product.count(),
    }).toEqual(before);
  });

  it("has no write route — POST is not allowed", async () => {
    // There is no way to "apply" a forecast, by design. Ordering goes through
    // the existing purchase-order flow, with a human in it.
    const s = await shop();
    await request(app)
      .post("/api/reports/forecast")
      .set("Authorization", `Bearer ${s.token}`)
      .send({})
      .expect((r) => {
        expect(r.status).toBeGreaterThanOrEqual(400);
      });
  });

  it("says plainly in the payload that it is advisory", async () => {
    // In the response, not only in the UI — anything else consuming this
    // inherits the caveat instead of having to already know it.
    const s = await shop();
    const res = await s.get("/api/reports/forecast").expect(200);
    expect(res.body.caveats.join(" ")).toMatch(/advisory only/i);
    expect(res.body.caveats.join(" ")).toMatch(/lead time/i);
  });
});

describe("forecast — the projection", () => {
  beforeEach(resetDb);

  it("projects steady demand over the horizon", async () => {
    const s = await shop();
    await s.buy(1000);
    await s.sellSteadily(60, 2); // 2/day for 60 days

    const res = await s.get("/api/reports/forecast?horizonDays=30").expect(200);
    const row = rowFor(res.body, s.product.id);

    expect(row.forecast.perDay).toBeGreaterThan(1);
    expect(row.forecast.perDay).toBeLessThan(3);
    expect(row.forecast.predictedDemand).toBeGreaterThan(40);
    expect(row.forecast.predictedDemand).toBeLessThan(80);
  });

  it("suggests a quantity that accounts for stock in hand", async () => {
    const s = await shop();
    await s.buy(1000); // plenty
    await s.sellSteadily(60, 2);

    const res = await s.get("/api/reports/forecast").expect(200);
    const row = rowFor(res.body, s.product.id);

    // ~60 forecast against ~880 available — nothing to order.
    expect(row.suggestion.suggestedQty).toBe(0);
    expect(row.suggestion.reason).toMatch(/already hold/i);
  });

  it("suggests ordering when stock will not cover the forecast", async () => {
    const s = await shop();
    await s.buy(130);
    await s.sellSteadily(60, 2); // 120 sold, 10 left, ~60 needed

    const res = await s.get("/api/reports/forecast").expect(200);
    const row = rowFor(res.body, s.product.id);

    expect(row.suggestion.suggestedQty).toBeGreaterThan(0);
    expect(row.available).toBe(10);
  });

  it("reports days of cover, the figure people actually act on", async () => {
    const s = await shop();
    await s.buy(140);
    await s.sellSteadily(60, 2); // 20 left at ~2/day → ~10 days

    const res = await s.get("/api/reports/forecast").expect(200);
    const row = rowFor(res.body, s.product.id);

    expect(row.daysOfCover).toBeGreaterThan(5);
    expect(row.daysOfCover).toBeLessThan(20);
  });

  it("returns null cover rather than Infinity when nothing sells", async () => {
    const s = await shop();
    await s.buy(100); // stocked, never sold

    const res = await s.get("/api/reports/forecast").expect(200);
    const row = rowFor(res.body, s.product.id);

    expect(row.forecast.predictedDemand).toBe(0);
    expect(row.daysOfCover).toBeNull(); // "runs out never" is not a number
  });
});

describe("forecast — what it excludes", () => {
  beforeEach(resetDb);

  it("does not count damaged stock as available", async () => {
    // Damaged goods are still ours and still in the valuation, but they cannot
    // fill an order. Counting them would advise against reordering stock that
    // can't be sold.
    const s = await shop();
    await s.buy(100);
    await stockService.createMovement(s.company.id, s.user.id, {
      productId: s.product.id,
      locationId: s.location.id,
      type: "ADJUSTMENT",
      quantity: 50,
      status: "DAMAGED",
    } as Parameters<typeof stockService.createMovement>[2]);

    const res = await s.get("/api/reports/forecast").expect(200);
    expect(rowFor(res.body, s.product.id).available).toBe(100); // not 150
  });

  it("can be narrowed to one location", async () => {
    const s = await shop();
    await s.buy(100);
    const godown = await prisma.location.create({
      data: { companyId: s.company.id, name: "Godown" },
    });

    const res = await s
      .get(`/api/reports/forecast?locationId=${godown.id}`)
      .expect(200);
    expect(rowFor(res.body, s.product.id).available).toBe(0);
  });

  it("rejects a location belonging to someone else", async () => {
    const ours = await shop();
    const theirs = await createTestCompany("Other Co");
    await ours
      .get(`/api/reports/forecast?locationId=${theirs.location.id}`)
      .expect(404);
  });

  it("never sees another company's sales", async () => {
    const ours = await shop();
    await ours.buy(100);
    const theirs = await shop();
    await theirs.buy(1000);
    await theirs.sellSteadily(60, 5);

    const res = await ours.get("/api/reports/forecast").expect(200);
    expect(rowFor(res.body, ours.product.id).forecast.predictedDemand).toBe(0);
  });
});

describe("forecast — refusing to guess", () => {
  beforeEach(resetDb);

  it("refuses on a product with almost no sales history", async () => {
    const s = await shop();
    await s.buy(100);
    await s.sellOn(5, 3); // one sale day, ever

    const res = await s.get("/api/reports/forecast").expect(200);
    const row = rowFor(res.body, s.product.id);

    expect(row.forecast.predictedDemand).toBeNull();
    expect(row.forecast.unavailableReason).toBeTruthy();
    // And the refusal must propagate — no quantity built on a missing number.
    expect(row.suggestion.suggestedQty).toBeNull();
  });

  it("counts how many products it could not forecast", async () => {
    // Surfaced as a total so the gap is visible without reading every row. A
    // forecast covering 3 of 40 products looks the same as one covering all 40
    // until you count.
    const s = await shop();
    await s.buy(100);
    await s.sellOn(5, 3);

    const res = await s.get("/api/reports/forecast").expect(200);
    expect(res.body.totals.noForecast).toBeGreaterThan(0);
    expect(res.body.totals.products).toBe(
      res.body.totals.forecast + res.body.totals.noForecast
    );
  });

  it("rejects a horizon outside the supported range", async () => {
    const s = await shop();
    await s.get("/api/reports/forecast?horizonDays=3650").expect(400);
  });
});
