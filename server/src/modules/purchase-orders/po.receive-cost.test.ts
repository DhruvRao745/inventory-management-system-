/**
 * Decimal quantities and the ACTUAL received cost (BUG-8 and BUG-9).
 *
 * BUG-8: "PI is counted in whole kg — 67.5 isn't a valid quantity" on a
 * product measured in kg. The validation was right and the PRODUCT was wrong:
 * `precision` defaulted to 0 and the product form never exposed it, so every
 * product ever created was whole-units-only whatever its unit said. These
 * tests pin the rule down per product so neither half can drift.
 *
 * BUG-9: a PO is agreed at one price and the supplier charges another. The
 * weighted average has to follow what we ACTUALLY paid, because inventory is
 * worth what it cost, not what we expected it to cost — and each receipt keeps
 * its own cost, because two deliveries against one order can be priced
 * differently and both are true.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import * as poService from "./po.service.js";
import { receiveSchema } from "./po.schemas.js";
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

/** A supplier plus a product whose unit and precision the test chooses. */
async function poSetup(opts: {
  unit: string;
  precision: number;
  tracksBatch?: boolean;
  quantity: number;
  unitCost: number;
}) {
  const base = await createTestCompany();

  const supplier = await prisma.supplier.create({
    data: { companyId: base.company.id, name: "Grain Co" },
  });

  const product = await prisma.product.create({
    data: {
      companyId: base.company.id,
      sku: "PI-1",
      name: "PI",
      unit: opts.unit,
      precision: opts.precision,
      tracksBatch: opts.tracksBatch ?? false,
      costPrice: opts.unitCost,
      sellingPrice: opts.unitCost * 2,
    },
  });

  const po = await poService.createPO(base.company.id, base.user.id, {
    supplierId: supplier.id,
    lines: [
      { productId: product.id, quantity: opts.quantity, unitCost: opts.unitCost },
    ],
  });
  await poService.changeStatus(base.company.id, po.id, "ORDERED");

  const lineId = po.lines[0]!.id;

  const receive = (
    quantity: number | string,
    extra: { batchNumber?: string; actualUnitCost?: number } = {}
  ) =>
    poService.receivePO(base.company.id, base.user.id, po.id, {
      locationId: base.location.id,
      lines: [{ lineId, quantity, ...extra }],
    });

  const avgCost = () =>
    prisma.product
      .findUniqueOrThrow({ where: { id: product.id } })
      .then((p) => Number(p.avgCost));

  return { ...base, supplier, product, po, lineId, receive, avgCost };
}

describe("decimal quantities on receiving", () => {
  beforeEach(resetDb);

  it("whole units: a whole-number quantity is accepted", async () => {
    const { receive } = await poSetup({
      unit: "pcs",
      precision: 0,
      quantity: 100,
      unitCost: 50,
    });
    const result = await receive(60);
    expect(result.status).toBe("PARTIAL");
  });

  it("THE BUG: 67.5 kg is accepted when the product allows 3 decimals", async () => {
    const { receive, product } = await poSetup({
      unit: "kg",
      precision: 3,
      quantity: 100,
      unitCost: 50,
    });

    await receive(67.5);

    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { productId: product.id, type: "PURCHASE" },
    });
    expect(Number(movement.quantity)).toBe(67.5);
  });

  it("still refuses a quantity finer than the product allows", async () => {
    // The rule is preserved, not removed. 0.5 kg is fine at 1 decimal place;
    // 0.5001 is not, and the message names the product and its unit.
    const { receive } = await poSetup({
      unit: "kg",
      precision: 1,
      quantity: 100,
      unitCost: 50,
    });

    await receive(67.5); // allowed
    const err = await expectAppError(receive(0.5001), 400);
    expect(err.message).toMatch(/too precise|isn't a valid quantity/i);
  });

  it("a whole-number-only product still refuses a fraction", async () => {
    // You cannot receive half a stapler, and that must stay true.
    const { receive } = await poSetup({
      unit: "pcs",
      precision: 0,
      quantity: 100,
      unitCost: 50,
    });
    const err = await expectAppError(receive(2.5), 400);
    expect(err.message).toMatch(/whole pcs/i);
  });

  it("litres and metres take decimals the same way", async () => {
    for (const unit of ["litre", "metre"]) {
      await resetDb();
      const { receive, product } = await poSetup({
        unit,
        precision: 2,
        quantity: 50,
        unitCost: 20,
      });
      await receive(12.25);
      const m = await prisma.stockMovement.findFirstOrThrow({
        where: { productId: product.id, type: "PURCHASE" },
      });
      expect(Number(m.quantity)).toBe(12.25);
    }
  });

  it("a batch-tracked kg product receives a decimal quantity into its lot", async () => {
    // The exact reported combination: batch-tracked, measured in kg, 67.5.
    const { receive, product } = await poSetup({
      unit: "kg",
      precision: 3,
      tracksBatch: true,
      quantity: 100,
      unitCost: 50,
    });

    await receive(67.5, { batchNumber: "WH-A" });

    const lot = await prisma.inventoryBatch.findFirstOrThrow({
      where: { productId: product.id },
    });
    expect(lot.batchNumber).toBe("WH-A");
    expect(Number(lot.remainingQuantity)).toBe(67.5);
  });
});

describe("actual received cost", () => {
  beforeEach(resetDb);

  it("defaults to the PO price when no actual cost is given", async () => {
    const { receive, avgCost, product } = await poSetup({
      unit: "pcs",
      precision: 0,
      quantity: 100,
      unitCost: 50,
    });

    await receive(60);

    expect(await avgCost()).toBe(50);
    const grn = await prisma.goodsReceiptLine.findFirstOrThrow({
      where: { productId: product.id },
    });
    expect(Number(grn.actualUnitCost)).toBe(50);
  });

  it("THE CASE: 100 @ ₹50 ordered, 60 received @ ₹52 — valued at 52", async () => {
    const { receive, avgCost, product, po } = await poSetup({
      unit: "pcs",
      precision: 0,
      quantity: 100,
      unitCost: 50,
    });

    await receive(60, { actualUnitCost: 52 });

    // The stock is worth what we paid.
    expect(await avgCost()).toBe(52);

    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { productId: product.id, type: "PURCHASE" },
    });
    expect(Number(movement.unitCost)).toBe(52);
    expect(Number(movement.costAtTime)).toBe(52);

    const grn = await prisma.goodsReceiptLine.findFirstOrThrow({
      where: { productId: product.id },
    });
    expect(Number(grn.actualUnitCost)).toBe(52);

    // ...and the ORDER still says what was agreed. Rewriting it would destroy
    // the evidence that the supplier charged something else.
    const fresh = await poService.getPO(po.companyId, po.id);
    expect(Number(fresh.lines[0]!.unitCost)).toBe(50);
  });

  it("two receipts at different costs each keep their own", async () => {
    // The same order, two deliveries, two prices — both true. The average
    // lands between them, weighted by quantity.
    const { receive, avgCost, product } = await poSetup({
      unit: "pcs",
      precision: 0,
      quantity: 100,
      unitCost: 50,
    });

    await receive(60, { actualUnitCost: 52 }); // 60 × 52 = 3120
    await receive(40, { actualUnitCost: 45 }); // 40 × 45 = 1800
    // (3120 + 1800) / 100 = 49.20
    expect(await avgCost()).toBe(49.2);

    const grnLines = await prisma.goodsReceiptLine.findMany({
      where: { productId: product.id },
      orderBy: { actualUnitCost: "desc" },
    });
    expect(grnLines.map((l) => Number(l.actualUnitCost))).toEqual([52, 45]);
  });

  it("the first receipt's cost is not rewritten by the second", async () => {
    // Historical costing stays immutable: what the first 60 cost is settled
    // the moment they arrive, whatever the next delivery is priced at.
    const { receive, product } = await poSetup({
      unit: "pcs",
      precision: 0,
      quantity: 100,
      unitCost: 50,
    });

    await receive(60, { actualUnitCost: 52 });
    const firstMovement = await prisma.stockMovement.findFirstOrThrow({
      where: { productId: product.id, type: "PURCHASE" },
      orderBy: { createdAt: "asc" },
    });
    const costBefore = Number(firstMovement.costAtTime);

    await receive(40, { actualUnitCost: 45 });

    const firstAgain = await prisma.stockMovement.findUniqueOrThrow({
      where: { id: firstMovement.id },
    });
    expect(Number(firstAgain.costAtTime)).toBe(costBefore);
    expect(Number(firstAgain.unitCost)).toBe(52);
  });

  it("a batch-tracked receipt values its lot at the actual cost", async () => {
    const { receive, product } = await poSetup({
      unit: "kg",
      precision: 3,
      tracksBatch: true,
      quantity: 100,
      unitCost: 50,
    });

    await receive(67.5, { batchNumber: "WH-A", actualUnitCost: 52 });

    const lot = await prisma.inventoryBatch.findFirstOrThrow({
      where: { productId: product.id },
    });
    expect(Number(lot.unitCost)).toBe(52);
    expect(Number(lot.remainingQuantity)).toBe(67.5);
  });

  it("a negative actual cost never reaches the service", async () => {
    // Checked at the schema, which is the layer the HTTP request passes
    // through — asserting it here rather than in the service is the honest
    // place, because that is where the guard actually is.
    const parsed = receiveSchema.safeParse({
      locationId: "loc_1",
      lines: [{ lineId: "line_1", quantity: 10, actualUnitCost: -1 }],
    });
    expect(parsed.success).toBe(false);

    const ok = receiveSchema.safeParse({
      locationId: "loc_1",
      lines: [{ lineId: "line_1", quantity: 10, actualUnitCost: 52 }],
    });
    expect(ok.success).toBe(true);
  });
});
