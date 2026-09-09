/**
 * The till must know what it is charging BEFORE it charges it (BUG-11).
 *
 * Found by manual testing on the live site: with "GST invoice" ticked, the
 * button read "Take ₹200" on a basket whose invoice came to ₹210. The cashier
 * collected ₹200; the books recorded ₹210 received. Every GST sale left the
 * drawer short, and nothing on screen explained why.
 *
 * The screen could not fix this alone: computing GST in the browser would be
 * the second tax engine `client/src/lib/gst.ts` exists to refuse. So the till
 * asks the server, and these tests pin the only property that matters — the
 * quote and the invoice must agree, because they are the same engine asked
 * twice. A quote that merely looks reasonable is worthless; one that equals
 * what is about to be charged is the whole point.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import * as posService from "./pos.service.js";
import * as stockService from "../stock/stock.service.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";

async function till() {
  const base = await createTestCompany();

  await prisma.company.update({
    where: { id: base.company.id },
    data: { stateCode: "08", gstin: "08AAAAA0000A1Z5" },
  });
  await prisma.product.update({
    where: { id: base.product.id },
    data: {
      gstRate: 5,
      sellingPrice: 80,
      costPrice: 50,
      // Sold by weight, so 2.5 is a legal quantity — the fixture product is
      // whole-units by default and the tax arithmetic is more interesting
      // with a fractional line.
      unit: "kg",
      precision: 3,
    },
  });

  await stockService.createMovement(base.company.id, base.user.id, {
    productId: base.product.id,
    locationId: base.location.id,
    type: "PURCHASE",
    quantity: 500,
    unitCost: 50,
  } as Parameters<typeof stockService.createMovement>[2]);

  const quote = (quantity: number, useGst: boolean) =>
    posService.posQuote(base.company.id, {
      locationId: base.location.id,
      useGst: useGst || undefined,
      lines: [{ productId: base.product.id, quantity }],
    } as Parameters<typeof posService.posQuote>[1]);

  const sell = (quantity: number, useGst: boolean) =>
    posService.posSale(base.company.id, base.user.id, {
      locationId: base.location.id,
      useGst: useGst || undefined,
      lines: [{ productId: base.product.id, quantity }],
      payment: { method: "CASH" },
    } as Parameters<typeof posService.posSale>[2]);

  return { ...base, quote, sell };
}

describe("POS quote — what the cashier is told to collect", () => {
  beforeEach(resetDb);

  it("THE BUG: a GST quote equals the invoice that follows it", async () => {
    // 2.5 × ₹80 = ₹200 + 5% = ₹210. The old till said ₹200.
    const { quote, sell } = await till();

    const q = await quote(2.5, true);
    expect(q.subtotal).toBe(200);
    expect(q.tax).toBe(10);
    expect(q.total).toBe(210);
    expect(q.taxed).toBe(true);

    const sale = await sell(2.5, true);
    expect(Number(sale.invoice.totalAmount)).toBe(q.total);
    // ...and the money taken is the money quoted, so the drawer balances.
    expect(sale.payment!.amount).toBe(q.total);
    expect(sale.balance).toBe(0);
  });

  it("a non-GST quote equals its invoice too", async () => {
    const { quote, sell } = await till();

    const q = await quote(2.5, false);
    expect(q.total).toBe(200);
    expect(q.taxed).toBe(false);

    const sale = await sell(2.5, false);
    expect(Number(sale.invoice.totalAmount)).toBe(q.total);
  });

  it("quoting writes nothing — no invoice, no stock, no number burned", async () => {
    // A price check is not a sale. A cashier who changes their mind must not
    // leave a cancelled invoice and a gap in the numbering behind them.
    const { company, product, quote } = await till();

    await quote(3, true);
    await quote(7, true);

    expect(await prisma.invoice.count({ where: { companyId: company.id } })).toBe(0);
    expect(
      await prisma.stockMovement.count({
        where: { companyId: company.id, productId: product.id, type: "SALE" },
      })
    ).toBe(0);
  });

  it("an empty basket quotes zero rather than failing", async () => {
    const { company, location } = await till();
    const q = await posService.posQuote(company.id, {
      locationId: location.id,
      lines: [],
    } as Parameters<typeof posService.posQuote>[1]);
    expect(q.total).toBe(0);
  });

  it("refuses to invent a total for a product with no GST rate decided", async () => {
    // The same rule the sale enforces: a blank rate is not 0%. Guessing one
    // here would be the till quietly deciding a tax question.
    const { company, user, location, quote } = await till();
    const unrated = await prisma.product.create({
      data: {
        companyId: company.id,
        sku: "NO-RATE",
        name: "Unrated thing",
        sellingPrice: 100,
        costPrice: 50,
        gstRate: null,
      },
    });
    await stockService.createMovement(company.id, user.id, {
      productId: unrated.id,
      locationId: location.id,
      type: "PURCHASE",
      quantity: 10,
      unitCost: 50,
    } as Parameters<typeof stockService.createMovement>[2]);

    const q = await posService.posQuote(company.id, {
      locationId: location.id,
      useGst: true,
      lines: [{ productId: unrated.id, quantity: 1 }],
    } as Parameters<typeof posService.posQuote>[1]);

    expect(q.unrated).toBe(true);
    expect(q.total).toBe(0);
    void quote;
  });

  it("prices from the catalogue, not from what the till sent", async () => {
    // A quote built from a stale browser price is a quote that can disagree
    // with the charge — the same reason posSale re-prices server-side.
    const { company, product, location } = await till();
    await prisma.product.update({
      where: { id: product.id },
      data: { sellingPrice: 999 },
    });

    const q = await posService.posQuote(company.id, {
      locationId: location.id,
      lines: [{ productId: product.id, quantity: 1 }],
    } as Parameters<typeof posService.posQuote>[1]);

    expect(q.total).toBe(999);
  });
});
