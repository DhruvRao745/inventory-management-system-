/**
 * Decimal quantities + UOM (P1-2).
 *
 * The rule under test: stock stored by weight or volume must stay EXACT.
 *
 * The bug this prevents is quiet and permanent. Sell 0.1 kg three times from a
 * 1 kg bag using JS numbers and the bag holds 0.7000000000000001 kg — forever.
 * Nothing errors, no test fails, and every report that touches it inherits the
 * lie. Decimal arithmetic end-to-end is the only fix.
 *
 * The second rule: `Decimal(18,4)` says the DATABASE can hold four decimal
 * places, not that a given product SHOULD. `Product.precision` decides that,
 * so nobody can book 0.333333 kg of rice and leave dust in the ledger that can
 * never be sold or counted.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import * as stockService from "./stock.service.js";
import * as invService from "../invoices/inv.service.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";

async function expectAppError(promise: Promise<unknown>, statusCode: number) {
  const err = await promise.then(
    () => null,
    (e) => e
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).statusCode).toBe(statusCode);
  return err as AppError;
}

/** A company plus a product stocked by weight (3 dp) and one by the piece. */
async function weightSetup() {
  const base = await createTestCompany();

  const rice = await prisma.product.create({
    data: {
      companyId: base.company.id,
      sku: "RICE-1KG",
      name: "Basmati Rice",
      unit: "kg",
      precision: 3, // grams
      costPrice: 60,
      sellingPrice: 95,
    },
  });

  // createTestCompany's product is precision 0 — whole units only.
  const move = (
    productId: string,
    type: "PURCHASE" | "SALE" | "ADJUSTMENT",
    quantity: number | string
  ) =>
    stockService.createMovement(base.company.id, base.user.id, {
      productId,
      locationId: base.location.id,
      type,
      quantity,
    } as Parameters<typeof stockService.createMovement>[2]);

  const level = (productId: string) =>
    stockService.getStockLevel(base.company.id, productId, base.location.id);

  return { ...base, rice, move, level };
}

describe("decimal quantities — exactness", () => {
  beforeEach(resetDb);

  it("0.1 three times out of 1 leaves exactly 0.7, not 0.7000000000000001", async () => {
    // The canonical float bug, in the one place it would do real damage.
    const { rice, move, level } = await weightSetup();
    await move(rice.id, "PURCHASE", 1);
    await move(rice.id, "SALE", 0.1);
    await move(rice.id, "SALE", 0.1);
    await move(rice.id, "SALE", 0.1);

    const remaining = await level(rice.id);
    expect(remaining.equals(new Prisma.Decimal("0.7"))).toBe(true);
    expect(remaining.toString()).toBe("0.7"); // exact — NOT 0.7000000000000001
  });

  it("accepts a fractional quantity within the product's precision", async () => {
    const { rice, move, level } = await weightSetup();
    await move(rice.id, "PURCHASE", 2.5);
    expect((await level(rice.id)).equals(new Prisma.Decimal("2.5"))).toBe(true);
  });

  it("accepts a quantity sent as a STRING, unmangled", async () => {
    // A client that sends "0.375" must not have it round-tripped through a
    // float on the way in.
    const { rice, move, level } = await weightSetup();
    await move(rice.id, "PURCHASE", "0.375");
    expect((await level(rice.id)).toString()).toBe("0.375");
  });

  it("many small movements never drift", async () => {
    const { rice, move, level } = await weightSetup();
    await move(rice.id, "PURCHASE", 10);
    for (let i = 0; i < 20; i++) await move(rice.id, "SALE", 0.001);
    // 10 − (20 × 0.001) = 9.98 exactly
    expect((await level(rice.id)).toString()).toBe("9.98");
  });

  it("a fractional sale still cannot oversell", async () => {
    const { rice, move, level } = await weightSetup();
    await move(rice.id, "PURCHASE", 0.5);
    await expectAppError(move(rice.id, "SALE", 0.501), 400);
    expect((await level(rice.id)).toString()).toBe("0.5");
  });
});

describe("decimal quantities — per-product precision", () => {
  beforeEach(resetDb);

  it("rejects a fraction on a whole-unit product", async () => {
    // You cannot sell half a stapler.
    const { product, move } = await weightSetup();
    const err = await expectAppError(move(product.id, "PURCHASE", 2.5), 400);
    expect(err.message).toContain("whole");
  });

  it("rejects a quantity finer than the product allows", async () => {
    // Rice is tracked to the gram (3 dp); 0.0001 kg is a tenth of a gram.
    const { rice, move } = await weightSetup();
    const err = await expectAppError(move(rice.id, "PURCHASE", 0.0001), 400);
    expect(err.message).toContain("too precise");
  });

  it("allows exactly the permitted number of places", async () => {
    const { rice, move, level } = await weightSetup();
    await move(rice.id, "PURCHASE", 1.234); // 3 dp — the limit
    expect((await level(rice.id)).toString()).toBe("1.234");
  });

  it("precision applies to invoices too, not just direct movements", async () => {
    const { company, user, location, product } = await weightSetup();
    await expectAppError(
      invService.createInvoice(company.id, user.id, {
        customerName: "Walk-in",
        locationId: location.id,
        lines: [{ productId: product.id, quantity: 1.5, unitPrice: 20 }],
      } as Parameters<typeof invService.createInvoice>[2]),
      400
    );
  });

  it("a rejected line leaves NO invoice behind", async () => {
    // Validation happens before any write — a bad line 2 must not leave a
    // half-built invoice with only line 1 on it.
    const { company, user, location, product, rice } = await weightSetup();
    await expectAppError(
      invService.createInvoice(company.id, user.id, {
        customerName: "Walk-in",
        locationId: location.id,
        lines: [
          { productId: rice.id, quantity: 1.5, unitPrice: 95 }, // fine
          { productId: product.id, quantity: 0.5, unitPrice: 20 }, // not
        ],
      } as Parameters<typeof invService.createInvoice>[2]),
      400
    );
    expect(await prisma.invoice.count()).toBe(0);
    expect(await prisma.invoiceLine.count()).toBe(0);
  });
});

describe("decimal quantities — money stays exact", () => {
  beforeEach(resetDb);

  it("a fractional line total doesn't drift", async () => {
    // 2.5 kg × ₹33.33 = ₹83.325. Computed as floats this is 83.32499999999999,
    // which rounds the wrong way and puts a paisa on the invoice that nobody
    // can account for.
    const { company, user, location, rice } = await weightSetup();
    const inv = await invService.createInvoice(company.id, user.id, {
      customerName: "Walk-in",
      locationId: location.id,
      lines: [{ productId: rice.id, quantity: 2.5, unitPrice: 33.33 }],
    } as Parameters<typeof invService.createInvoice>[2]);

    const list = await invService.listInvoices(company.id, {
      take: 10,
      skip: 0,
    } as never);
    const row = list.items.find((r) => r.id === inv.id)!;
    expect(row.total).toBeCloseTo(83.33, 2);
  });

  it("issuing a fractional invoice deducts the exact amount", async () => {
    const { company, user, location, rice, move, level } = await weightSetup();
    await move(rice.id, "PURCHASE", 10);

    const inv = await invService.createInvoice(company.id, user.id, {
      customerName: "Walk-in",
      locationId: location.id,
      lines: [{ productId: rice.id, quantity: 2.75, unitPrice: 95 }],
    } as Parameters<typeof invService.createInvoice>[2]);
    await invService.issueInvoice(company.id, user.id, inv.id);

    expect((await level(rice.id)).toString()).toBe("7.25");
  });
});

describe("decimal quantities — units of measure", () => {
  beforeEach(resetDb);

  it("stores an optional pack conversion", async () => {
    const { company } = await weightSetup();
    const boxed = await prisma.product.create({
      data: {
        companyId: company.id,
        sku: "PEN-BOX",
        name: "Pens",
        unit: "pcs",
        packUnit: "box",
        unitsPerPack: 12,
        costPrice: 5,
        sellingPrice: 10,
      },
    });
    expect(boxed.packUnit).toBe("box");
    expect(Number(boxed.unitsPerPack)).toBe(12);
  });

  it("lowStockThreshold can itself be fractional", async () => {
    // 0.5 kg is as reasonable a reorder point as 5 pieces.
    const { company, user, location, rice, move } = await weightSetup();
    await prisma.product.update({
      where: { id: rice.id },
      data: { lowStockThreshold: new Prisma.Decimal("0.5") },
    });
    await move(rice.id, "PURCHASE", 2);
    await move(rice.id, "SALE", 1.6); // 0.4 left — below 0.5

    const levels = await stockService.stockLevels(company.id, {} as never);
    const row = levels.find((l) => l!.product.id === rice.id)!;
    expect(row.lowStock).toBe(true);
    void user;
    void location;
  });
});
