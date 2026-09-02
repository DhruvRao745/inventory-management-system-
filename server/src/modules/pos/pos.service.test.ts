/**
 * Point of sale (P3-4).
 *
 * The spec: "POS sales must use the same inventory, pricing, tax, payment and
 * stock-movement logic as normal sales. Do not create a separate inventory
 * system for POS."
 *
 * The first block below is the one that enforces that, and it is the reason
 * this file exists. It rings up a sale two ways — through the till and through
 * the ordinary invoice screen — and asserts the two are indistinguishable in
 * the ledger. A comment claiming "we reuse the invoice service" would survive
 * someone quietly adding a stock write here. That test would not.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { prisma } from "../../lib/prisma.js";
import { app } from "../../app.js";
import * as posService from "./pos.service.js";
import * as invService from "../invoices/inv.service.js";
import * as stockService from "../stock/stock.service.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";

async function till() {
  const base = await createTestCompany();
  const token = jwt.sign(
    { userId: base.user.id, companyId: base.company.id, role: "ADMIN" },
    env.JWT_SECRET,
    { expiresIn: "15m" }
  );

  const stock = (quantity: number, unitCost = 40) =>
    stockService.createMovement(base.company.id, base.user.id, {
      productId: base.product.id,
      locationId: base.location.id,
      type: "PURCHASE",
      quantity,
      unitCost,
    } as Parameters<typeof stockService.createMovement>[2]);

  const sell = (input: Partial<posService.PosSaleResult> | object = {}) =>
    posService.posSale(base.company.id, base.user.id, {
      locationId: base.location.id,
      lines: [{ productId: base.product.id, quantity: 2 }],
      payment: { method: "CASH" },
      ...input,
    } as Parameters<typeof posService.posSale>[2]);

  const post = (body: object) =>
    request(app)
      .post("/api/pos/sale")
      .set("Authorization", `Bearer ${token}`)
      .send(body);

  const onHand = async () => {
    const g = await prisma.stockMovement.aggregate({
      where: { companyId: base.company.id, productId: base.product.id },
      _sum: { quantity: true },
    });
    return Number(g._sum.quantity ?? 0);
  };

  return { ...base, token, stock, sell, post, onHand };
}

/* ==================================================================== *
 * The constraint                                                        *
 * ==================================================================== */

describe("POS — it is the same system", () => {
  beforeEach(resetDb);

  it("a till sale and a typed invoice leave IDENTICAL ledger effects", async () => {
    // THE test. Same goods, same quantity, same price, two routes in.
    const t = await till();
    await t.stock(100, 40);

    // Route 1: the till.
    await t.sell({ lines: [{ productId: t.product.id, quantity: 3, unitPrice: 90 }] });

    // Route 2: the invoice screen, by hand.
    const manual = await invService.createInvoice(t.company.id, t.user.id, {
      customerName: "Walk-in customer",
      locationId: t.location.id,
      lines: [{ productId: t.product.id, quantity: 3, unitPrice: 90 }],
    } as Parameters<typeof invService.createInvoice>[2]);
    await invService.issueInvoice(t.company.id, t.user.id, manual.id);

    const movements = await prisma.stockMovement.findMany({
      where: { companyId: t.company.id, type: "SALE" },
      orderBy: { createdAt: "asc" },
      select: { quantity: true, costAtTime: true, status: true, locationId: true },
    });

    expect(movements).toHaveLength(2);
    // Quantity, stamped cost, condition bucket, shelf — all equal. If the POS
    // ever grows its own stock-writing path, one of these diverges.
    expect(movements[0]).toEqual(movements[1]);
  });

  it("deducts stock through the ordinary issue path", async () => {
    const t = await till();
    await t.stock(100);
    await t.sell({ lines: [{ productId: t.product.id, quantity: 4 }] });
    expect(await t.onHand()).toBe(96);
  });

  it("stamps the weighted-average cost, so POS sales appear in COGS", async () => {
    // The failure this guards against is silent and slow: counter sales that
    // never reach the profit report, discovered months later.
    const t = await till();
    await t.stock(100, 40);
    await t.sell({ lines: [{ productId: t.product.id, quantity: 2 }] });

    const m = await prisma.stockMovement.findFirstOrThrow({
      where: { companyId: t.company.id, type: "SALE" },
    });
    expect(Number(m.costAtTime)).toBe(40);
  });

  it("refuses to oversell, exactly like an invoice", async () => {
    const t = await till();
    await t.stock(3);
    await expect(
      t.sell({ lines: [{ productId: t.product.id, quantity: 5 }] })
    ).rejects.toThrow();
    expect(await t.onHand()).toBe(3); // nothing moved
  });

  it("records the sale as an ordinary invoice, marked POS", async () => {
    const t = await till();
    await t.stock(50);
    const res = await t.sell();

    expect(res.invoice.source).toBe("POS");
    expect(res.invoice.status).toBe("PAID");
    // Same numbering sequence — a shop has ONE run of invoice numbers, not a
    // separate till series that collides with it.
    expect(res.invoice.number).toBe(1);
  });

  it("shares the invoice number sequence with typed invoices", async () => {
    const t = await till();
    await t.stock(50);
    await t.sell();
    const manual = await invService.createInvoice(t.company.id, t.user.id, {
      customerName: "Someone",
      locationId: t.location.id,
      lines: [{ productId: t.product.id, quantity: 1, unitPrice: 10 }],
    } as Parameters<typeof invService.createInvoice>[2]);
    expect(manual.number).toBe(2);
  });
});

/* ==================================================================== *
 * Pricing                                                               *
 * ==================================================================== */

describe("POS — pricing comes from the server", () => {
  beforeEach(resetDb);

  it("uses the catalogue price when the till sends none", async () => {
    // A price sent up from the browser is whatever that tab loaded — possibly
    // hours ago, possibly edited. The resulting invoice would look completely
    // ordinary afterwards, which is what makes it worth preventing.
    const t = await till();
    await t.stock(50);
    await prisma.product.update({
      where: { id: t.product.id },
      data: { sellingPrice: 125 },
    });

    const res = await t.sell({ lines: [{ productId: t.product.id, quantity: 2 }] });
    expect(Number(res.invoice.lines[0]!.unitPrice)).toBe(125);
  });

  it("allows an explicit override, and records it on the line", async () => {
    // Haggling at a counter is real. It is written to the line like any other
    // price, so the discount is visible rather than buried in a total.
    const t = await till();
    await t.stock(50);
    const res = await t.sell({
      lines: [{ productId: t.product.id, quantity: 1, unitPrice: 5 }],
    });
    expect(Number(res.invoice.lines[0]!.unitPrice)).toBe(5);
  });

  it("will not sell a retired product", async () => {
    const t = await till();
    await t.stock(50);
    await prisma.product.update({
      where: { id: t.product.id },
      data: { isActive: false },
    });
    await expect(t.sell()).rejects.toThrow(/retired/i);
  });
});

/* ==================================================================== *
 * Payment                                                               *
 * ==================================================================== */

describe("POS — taking money", () => {
  beforeEach(resetDb);

  it("settles the invoice in full by default", async () => {
    const t = await till();
    await t.stock(50);
    const res = await t.sell({
      lines: [{ productId: t.product.id, quantity: 2, unitPrice: 100 }],
    });

    expect(res.payment!.amount).toBe(200);
    expect(res.balance).toBe(0);
    expect(res.invoice.status).toBe("PAID");
  });

  it("returns CHANGE rather than recording an overpayment", async () => {
    // ₹500 tendered against a ₹380 bill is ₹120 of coins going back across the
    // counter — not a credit note. Recording the full ₹500 would leave the
    // invoice permanently in credit for money the shop does not have.
    const t = await till();
    await t.stock(50);
    const res = await t.sell({
      lines: [{ productId: t.product.id, quantity: 2, unitPrice: 190 }],
      payment: { method: "CASH", amount: 500 },
    });

    expect(res.payment!.amount).toBe(380); // applied
    expect(res.payment!.change).toBe(120); // handed back
    expect(res.balance).toBe(0);

    const paid = await prisma.payment.aggregate({
      where: { companyId: t.company.id },
      _sum: { amount: true },
    });
    expect(Number(paid._sum.amount)).toBe(380); // never 500
  });

  it("accepts a part payment and leaves the rest owing", async () => {
    const t = await till();
    await t.stock(50);
    const res = await t.sell({
      lines: [{ productId: t.product.id, quantity: 2, unitPrice: 100 }],
      payment: { method: "CASH", amount: 120 },
    });
    expect(res.balance).toBe(80);
    expect(res.invoice.status).toBe("ISSUED"); // not PAID
  });

  it("allows an on-account sale with no payment at all", async () => {
    // A staff purchase or a known customer's tab. An issued unpaid invoice is
    // a state the system already models — it appears in outstanding balances
    // like any other.
    const t = await till();
    await t.stock(50);
    const res = await t.sell({
      lines: [{ productId: t.product.id, quantity: 1, unitPrice: 60 }],
      payment: undefined,
    });

    expect(res.payment).toBeNull();
    expect(res.balance).toBe(60);
    expect(res.invoice.status).toBe("ISSUED");
    expect(await t.onHand()).toBe(49); // stock still moved
  });

  it("records the payment method the customer actually used", async () => {
    const t = await till();
    await t.stock(50);
    await t.sell({
      lines: [{ productId: t.product.id, quantity: 1, unitPrice: 60 }],
      payment: { method: "UPI", reference: "upi-8842" },
    });
    const p = await prisma.payment.findFirstOrThrow({
      where: { companyId: t.company.id },
    });
    expect(p.method).toBe("UPI");
    expect(p.reference).toBe("upi-8842");
  });
});

/* ==================================================================== *
 * Tax                                                                   *
 * ==================================================================== */

describe("POS — tax is the same tax", () => {
  beforeEach(resetDb);

  it("stamps GST through the ordinary path", async () => {
    const t = await till();
    await prisma.company.update({
      where: { id: t.company.id },
      data: { stateCode: "27" },
    });
    await prisma.product.update({
      where: { id: t.product.id },
      data: { gstRate: 18 },
    });
    await t.stock(50);

    const res = await t.sell({
      lines: [{ productId: t.product.id, quantity: 1, unitPrice: 100 }],
      useGst: true,
    });

    const line = res.invoice.lines[0]!;
    expect(res.invoice.taxMode).toBe("GST");
    // Intra-state: split into CGST + SGST, not IGST.
    expect(Number(line.cgstAmount)).toBeGreaterThan(0);
    expect(Number(line.sgstAmount)).toBeGreaterThan(0);
    expect(Number(line.igstAmount ?? 0)).toBe(0);
  });

  it("charges IGST on an inter-state counter sale", async () => {
    const t = await till();
    await prisma.company.update({
      where: { id: t.company.id },
      data: { stateCode: "27" },
    });
    await prisma.product.update({
      where: { id: t.product.id },
      data: { gstRate: 18 },
    });
    await t.stock(50);

    const res = await t.sell({
      lines: [{ productId: t.product.id, quantity: 1, unitPrice: 100 }],
      useGst: true,
      placeOfSupply: "29",
    });

    const line = res.invoice.lines[0]!;
    expect(Number(line.igstAmount)).toBeGreaterThan(0);
    expect(Number(line.cgstAmount ?? 0)).toBe(0);
  });

  it("charges the customer the tax-inclusive total", async () => {
    // The payment must settle the full bill INCLUDING tax. Paying the
    // pre-tax subtotal would leave every GST sale short by the tax.
    const t = await till();
    await prisma.company.update({
      where: { id: t.company.id },
      data: { stateCode: "27" },
    });
    await prisma.product.update({
      where: { id: t.product.id },
      data: { gstRate: 18 },
    });
    await t.stock(50);

    const res = await t.sell({
      lines: [{ productId: t.product.id, quantity: 1, unitPrice: 100 }],
      useGst: true,
    });

    expect(res.payment!.amount).toBeGreaterThan(100); // 100 + tax
    expect(res.balance).toBe(0);
    expect(res.invoice.status).toBe("PAID");
  });
});

/* ==================================================================== *
 * The route                                                             *
 * ==================================================================== */

describe("POS — over HTTP", () => {
  beforeEach(resetDb);

  it("rings up a sale and returns the invoice", async () => {
    const t = await till();
    await t.stock(50);
    const res = await t
      .post({
        locationId: t.location.id,
        lines: [{ productId: t.product.id, quantity: 2 }],
        payment: { method: "CASH" },
      })
      .expect(201);

    expect(res.body.invoice.source).toBe("POS");
    expect(res.body.invoice.status).toBe("PAID");
  });

  it("rejects an empty basket", async () => {
    const t = await till();
    await t.post({ locationId: t.location.id, lines: [] }).expect(400);
  });

  it("cannot be told the sale came from somewhere else", async () => {
    // `source` is a service parameter, not a request field — a client that
    // could set it could make counter sales appear in the till's takings, or
    // hide them from it.
    const t = await till();
    await t.stock(50);
    const res = await t
      .post({
        locationId: t.location.id,
        lines: [{ productId: t.product.id, quantity: 1 }],
        source: "MANUAL",
      })
      .expect(201);
    expect(res.body.invoice.source).toBe("POS");
  });

  it("will not sell out of another company's location", async () => {
    const ours = await till();
    const theirs = await createTestCompany("Other Co");
    await ours
      .post({
        locationId: theirs.location.id,
        lines: [{ productId: ours.product.id, quantity: 1 }],
      })
      .expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
  });

  it("needs authentication", async () => {
    const t = await till();
    await request(app)
      .post("/api/pos/sale")
      .send({ locationId: t.location.id, lines: [] })
      .expect(401);
  });
});
