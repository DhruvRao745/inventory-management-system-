/**
 * One definition of revenue (BUG-15), and stock is never valued at nothing
 * by accident (BUG-14).
 *
 * BUG-15 was found by reading the Reports page top to bottom: the Sales card
 * said ₹340 and the Profitability card said ₹310 for the same period, on the
 * same screen. Sales summed invoice TOTALS (tax included); Profitability
 * summed line values (tax excluded, discount ignored). Each was defensible on
 * its own and the pair was not.
 *
 * Revenue is now defined once: billed for the GOODS, after discount, before
 * tax. GST is collected for the government — it passes through the till and
 * back out, and counting it as revenue overstates the top line and makes the
 * margin meaningless.
 *
 * These tests assert AGREEMENT between the three cards rather than three
 * separate magic numbers, because agreement is the property that broke.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { prisma } from "../../lib/prisma.js";
import { app } from "../../app.js";
import * as invService from "../invoices/inv.service.js";
import * as stockService from "../stock/stock.service.js";
import { invoiceRevenueDecimal, lineRevenues } from "../../lib/money.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { Prisma } from "@prisma/client";

/** A signed-in ADMIN for the given fixture — same pattern as the other
 *  endpoint tests in this folder. */
function tokenFor(base: Awaited<ReturnType<typeof createTestCompany>>) {
  return jwt.sign(
    { userId: base.user.id, companyId: base.company.id, role: "ADMIN" },
    env.JWT_SECRET,
    { expiresIn: "15m" }
  );
}

const FROM = "2026-01-01T00:00:00.000Z";
const TO = "2099-12-31T00:00:00.000Z";

async function shop() {
  const base = await createTestCompany();
  const token = tokenFor(base);

  await prisma.company.update({
    where: { id: base.company.id },
    data: { stateCode: "08", gstin: "08AAAAA0000A1Z5" },
  });
  await prisma.product.update({
    where: { id: base.product.id },
    data: { gstRate: 5, sellingPrice: 80, costPrice: 50 },
  });

  await stockService.createMovement(base.company.id, base.user.id, {
    productId: base.product.id,
    locationId: base.location.id,
    type: "PURCHASE",
    quantity: 500,
    unitCost: 50,
  } as Parameters<typeof stockService.createMovement>[2]);

  const sell = async (opts: {
    useGst: boolean;
    quantity?: number;
    discount?: number;
  }) => {
    const draft = await invService.createInvoice(base.company.id, base.user.id, {
      customerName: "Walk-in",
      locationId: base.location.id,
      useGst: opts.useGst,
      ...(opts.useGst ? { placeOfSupply: "08" } : {}),
      ...(opts.discount ? { discount: opts.discount } : {}),
      lines: [
        {
          productId: base.product.id,
          quantity: opts.quantity ?? 10,
          unitPrice: 80,
        },
      ],
    } as Parameters<typeof invService.createInvoice>[2]);
    await invService.issueInvoice(base.company.id, base.user.id, draft.id);
    return draft.id;
  };

  const get = (path: string) =>
    request(app).get(path).set("Authorization", `Bearer ${token}`);

  return { ...base, sell, get };
}

describe("revenue has ONE definition", () => {
  beforeEach(resetDb);

  it("THE BUG: Sales and Profitability report the same revenue", async () => {
    const { sell, get } = await shop();
    await sell({ useGst: true }); // 10 × 80 = 800 + 5% = 840

    const sales = await get(`/api/reports/sales?from=${FROM}&to=${TO}`).expect(200);
    const profit = await get(
      `/api/reports/profitability?from=${FROM}&to=${TO}`
    ).expect(200);

    expect(sales.body.totals.revenue).toBe(800); // goods, not the 840 billed
    expect(sales.body.totals.revenue).toBe(profit.body.totals.revenue);
  });

  it("the amount BILLED is still reported — it just isn't called revenue", async () => {
    const { sell, get } = await shop();
    await sell({ useGst: true });

    const sales = await get(`/api/reports/sales?from=${FROM}&to=${TO}`).expect(200);
    expect(sales.body.totals.invoiced).toBe(840);
    expect(sales.body.totals.revenue).toBe(800);
  });

  it("the dashboard agrees with the page it summarises", async () => {
    const { sell, get } = await shop();
    await sell({ useGst: true });

    // /summary is the MOVEMENT summary; the dashboard lives at /dashboard.
    const dash = await get(`/api/reports/dashboard?from=${FROM}&to=${TO}`).expect(
      200
    );
    const sales = await get(`/api/reports/sales?from=${FROM}&to=${TO}`).expect(200);

    expect(dash.body.sales.revenue).toBe(sales.body.totals.revenue);
  });

  it("a discount reduces revenue — it used to be ignored here", async () => {
    // Profitability summed raw line values, so a discounted invoice reported
    // more revenue than it earned and the margin came out flattering.
    const { sell, get } = await shop();
    await sell({ useGst: false, discount: 100 }); // 800 − 100 = 700

    const profit = await get(
      `/api/reports/profitability?from=${FROM}&to=${TO}`
    ).expect(200);
    const sales = await get(`/api/reports/sales?from=${FROM}&to=${TO}`).expect(200);

    expect(profit.body.totals.revenue).toBe(700);
    expect(sales.body.totals.revenue).toBe(700);
  });

  it("per-product revenue sums back to the total", async () => {
    // A breakdown that nearly adds up is worse than none: it invites someone
    // to reconcile it and lose an afternoon.
    const { sell, get } = await shop();
    await sell({ useGst: true });

    const sales = await get(`/api/reports/sales?from=${FROM}&to=${TO}`).expect(200);
    const summed = sales.body.byProduct.reduce(
      (s: number, p: { revenue: number }) => s + p.revenue,
      0
    );
    expect(Math.round(summed * 100) / 100).toBe(sales.body.totals.revenue);
  });

  it("the helpers agree with each other", () => {
    // lineRevenues must always sum to invoiceRevenueDecimal, or a per-product
    // report and an invoice-level one drift apart again.
    const D = (n: number) => new Prisma.Decimal(n);
    const flat = {
      taxMode: "FLAT",
      taxRate: null,
      discount: D(10),
      lines: [
        { quantity: D(3), unitPrice: D(10) },
        { quantity: D(1), unitPrice: D(20) },
      ],
    };
    const perLine = lineRevenues(flat);
    const summed = perLine.reduce((s, v) => s.plus(v), D(0));
    expect(Number(summed)).toBe(Number(invoiceRevenueDecimal(flat)));
    expect(Number(summed)).toBe(40); // 50 − 10, with no rounding crumbs
  });
});

describe("incoming stock is never valued at nothing by accident", () => {
  beforeEach(resetDb);

  it("THE BUG: a first delivery with no unit cost uses the product's cost price", async () => {
    // Found live: 67.5 kg received with the optional Unit cost left blank
    // entered stock at ₹0, because the fallback was avgCost and a brand-new
    // product's avgCost is zero. The valuation showed ₹0 against ₹5,200 of
    // retail and the first sale reported a 100% margin.
    const base = await createTestCompany();
    const fresh = await prisma.product.create({
      data: {
        companyId: base.company.id,
        sku: "QA-NEW",
        name: "Brand new thing",
        costPrice: 50,
        sellingPrice: 80,
      },
    });

    await stockService.createMovement(base.company.id, base.user.id, {
      productId: fresh.id,
      locationId: base.location.id,
      type: "PURCHASE",
      quantity: 10,
      // no unitCost — the case that used to value this at zero
    } as Parameters<typeof stockService.createMovement>[2]);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: fresh.id },
    });
    expect(Number(after.avgCost)).toBe(50);
    expect(Number(after.stockValue)).toBe(500);
  });

  it("a stated unit cost still wins over everything", async () => {
    const base = await createTestCompany();
    const fresh = await prisma.product.create({
      data: {
        companyId: base.company.id,
        sku: "QA-NEW-2",
        name: "Another thing",
        costPrice: 50,
        sellingPrice: 80,
      },
    });

    await stockService.createMovement(base.company.id, base.user.id, {
      productId: fresh.id,
      locationId: base.location.id,
      type: "PURCHASE",
      quantity: 10,
      unitCost: 62,
    } as Parameters<typeof stockService.createMovement>[2]);

    expect(
      Number(
        (await prisma.product.findUniqueOrThrow({ where: { id: fresh.id } }))
          .avgCost
      )
    ).toBe(62);
  });

  it("once there IS a running average, it beats the reference cost price", async () => {
    // costPrice is a number somebody typed; avgCost is what the goods have
    // actually cost. The moment the second exists it wins.
    const base = await createTestCompany();
    const p = await prisma.product.create({
      data: {
        companyId: base.company.id,
        sku: "QA-NEW-3",
        name: "Third thing",
        costPrice: 50,
        sellingPrice: 80,
      },
    });

    await stockService.createMovement(base.company.id, base.user.id, {
      productId: p.id,
      locationId: base.location.id,
      type: "PURCHASE",
      quantity: 10,
      unitCost: 20,
    } as Parameters<typeof stockService.createMovement>[2]);

    // Second delivery, no price given: should follow the ₹20 average, not the
    // ₹50 that is still sitting on the product form.
    await stockService.createMovement(base.company.id, base.user.id, {
      productId: p.id,
      locationId: base.location.id,
      type: "PURCHASE",
      quantity: 10,
    } as Parameters<typeof stockService.createMovement>[2]);

    const after = await prisma.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(Number(after.avgCost)).toBe(20);
    expect(Number(after.stockValue)).toBe(400);
  });

  it("with no cost on file anywhere, it is still zero — and that is honest", async () => {
    // Nothing to infer from. The UI says so before you submit; inventing a
    // number here would be worse than reporting nothing.
    const base = await createTestCompany();
    const p = await prisma.product.create({
      data: {
        companyId: base.company.id,
        sku: "QA-NEW-4",
        name: "No cost anywhere",
        costPrice: 0,
        sellingPrice: 80,
      },
    });

    await stockService.createMovement(base.company.id, base.user.id, {
      productId: p.id,
      locationId: base.location.id,
      type: "PURCHASE",
      quantity: 10,
    } as Parameters<typeof stockService.createMovement>[2]);

    expect(
      Number(
        (await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).avgCost
      )
    ).toBe(0);
  });
});
