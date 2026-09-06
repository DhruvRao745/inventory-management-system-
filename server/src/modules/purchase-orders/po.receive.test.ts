/**
 * Receiving against a purchase order, with and without batch tracking.
 *
 * These exist because of a P1 regression found in testing: the Receive form
 * had no batch-number field, so a batch-tracked line could only ever be
 * rejected. The server side was correct the whole time — which is exactly why
 * it needed tests. A rule only one side of the wire knows about is a rule that
 * quietly stops being usable the moment the other side forgets it.
 *
 * What's asserted here is the CONTRACT the form depends on:
 *   - the PO endpoint tells the client which lines track batches
 *   - a batch number is required for those lines, and only those
 *   - the number reaches all three places that need it (receipt line, stock
 *     movement, inventory lot)
 *   - partial receiving keeps each consignment's batch separate
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import * as poService from "./po.service.js";
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

/**
 * A supplier and two products — one batch-tracked ("Wheat", the product from
 * the bug report), one not — plus a placed PO covering both.
 */
async function poSetup() {
  const base = await createTestCompany();

  const supplier = await prisma.supplier.create({
    data: { companyId: base.company.id, name: "Grain Co" },
  });

  const wheat = await prisma.product.create({
    data: {
      companyId: base.company.id,
      sku: "WHEAT-50",
      name: "Wheat",
      costPrice: 30,
      sellingPrice: 45,
      tracksBatch: true,
    },
  });

  // base.product (Test Widget) is deliberately NOT batch-tracked.
  const widget = base.product;

  const po = await poService.createPO(base.company.id, base.user.id, {
    supplierId: supplier.id,
    lines: [
      { productId: wheat.id, quantity: 100, unitCost: 30 },
      { productId: widget.id, quantity: 10, unitCost: 10 },
    ],
  });
  await poService.changeStatus(base.company.id, po.id, "ORDERED");

  const lineFor = (productId: string) =>
    po.lines.find((l) => l.productId === productId)!;

  const onHand = async (productId: string) => {
    const rows = await prisma.stockMovement.findMany({
      where: { companyId: base.company.id, productId },
      select: { quantity: true },
    });
    return rows.reduce((s, r) => s + Number(r.quantity), 0);
  };

  return { ...base, supplier, wheat, widget, po, lineFor, onHand };
}

describe("PO receiving — the batch-number contract", () => {
  beforeEach(resetDb);

  it("tells the client which lines are batch-tracked", async () => {
    // The regression itself: without this the Receive form cannot know it
    // needs a batch field, so it renders none and the user is rejected on
    // submit for a field they were never shown.
    const { company, po, wheat, widget } = await poSetup();

    const fetched = await poService.getPO(company.id, po.id);
    const wheatLine = fetched.lines.find((l) => l.productId === wheat.id)!;
    const widgetLine = fetched.lines.find((l) => l.productId === widget.id)!;

    expect(wheatLine.product.tracksBatch).toBe(true);
    expect(widgetLine.product.tracksBatch).toBe(false);
  });

  it("refuses a batch-tracked line with no batch number", async () => {
    const { company, user, location, po, wheat, lineFor, onHand } =
      await poSetup();

    const err = await expectAppError(
      poService.receivePO(company.id, user.id, po.id, {
        locationId: location.id,
        lines: [{ lineId: lineFor(wheat.id).id, quantity: 100 }],
      }),
      400
    );
    expect(err.message).toMatch(/batch-tracked/i);

    // Nothing leaked through: the whole receipt is validated before a single
    // row is written.
    expect(await onHand(wheat.id)).toBe(0);
    expect(await prisma.goodsReceipt.count()).toBe(0);
    expect((await poService.getPO(company.id, po.id)).status).toBe("ORDERED");
  });

  it("stores the batch number on the receipt, the movement and the lot", async () => {
    const { company, user, location, po, wheat, lineFor } = await poSetup();

    await poService.receivePO(company.id, user.id, po.id, {
      locationId: location.id,
      lines: [
        {
          lineId: lineFor(wheat.id).id,
          quantity: 100,
          batchNumber: "WH-2026-04",
        },
      ],
    });

    const grnLine = await prisma.goodsReceiptLine.findFirstOrThrow({
      where: { productId: wheat.id },
    });
    expect(grnLine.batchNumber).toBe("WH-2026-04");

    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { productId: wheat.id, type: "PURCHASE" },
    });
    expect(movement.batchNumber).toBe("WH-2026-04");

    const lot = await prisma.inventoryBatch.findFirstOrThrow({
      where: { productId: wheat.id },
    });
    expect(lot.batchNumber).toBe("WH-2026-04");
    expect(Number(lot.receivedQuantity)).toBe(100);
    expect(Number(lot.remainingQuantity)).toBe(100);
  });

  it("receives a non-batch-tracked line with no batch number at all", async () => {
    const { company, user, location, po, widget, lineFor, onHand } =
      await poSetup();

    await poService.receivePO(company.id, user.id, po.id, {
      locationId: location.id,
      lines: [{ lineId: lineFor(widget.id).id, quantity: 10 }],
    });

    expect(await onHand(widget.id)).toBe(10);
    // No lot is invented for a product that doesn't track batches.
    expect(
      await prisma.inventoryBatch.count({ where: { productId: widget.id } })
    ).toBe(0);
    // One line of two received → PARTIAL, not RECEIVED.
    expect((await poService.getPO(company.id, po.id)).status).toBe("PARTIAL");
  });

  it("takes both lines in one receipt, batch only where required", async () => {
    const { company, user, location, po, wheat, widget, lineFor, onHand } =
      await poSetup();

    const result = await poService.receivePO(company.id, user.id, po.id, {
      locationId: location.id,
      lines: [
        { lineId: lineFor(wheat.id).id, quantity: 100, batchNumber: "WH-A" },
        { lineId: lineFor(widget.id).id, quantity: 10 },
      ],
    });

    expect(result.status).toBe("RECEIVED");
    expect(await onHand(wheat.id)).toBe(100);
    expect(await onHand(widget.id)).toBe(10);
  });

  it("partial receiving keeps each consignment's batch separate", async () => {
    // Why a batch number belongs to the RECEIPT and not the PO line: 100 kg
    // ordered can arrive as two pallets from two different lots.
    const { company, user, location, po, wheat, lineFor } = await poSetup();
    const wheatLineId = lineFor(wheat.id).id;

    const first = await poService.receivePO(company.id, user.id, po.id, {
      locationId: location.id,
      lines: [{ lineId: wheatLineId, quantity: 60, batchNumber: "WH-A" }],
    });
    expect(first.status).toBe("PARTIAL");

    const second = await poService.receivePO(company.id, user.id, po.id, {
      locationId: location.id,
      lines: [{ lineId: wheatLineId, quantity: 40, batchNumber: "WH-B" }],
    });
    expect(second.status).toBe("PARTIAL"); // the widget line is still owed

    const lots = await prisma.inventoryBatch.findMany({
      where: { productId: wheat.id },
      orderBy: { batchNumber: "asc" },
    });
    expect(lots.map((l) => l.batchNumber)).toEqual(["WH-A", "WH-B"]);
    expect(lots.map((l) => Number(l.remainingQuantity))).toEqual([60, 40]);
  });

  it("still refuses to over-receive a batch-tracked line", async () => {
    // The batch fix must not have loosened the quantity guard.
    const { company, user, location, po, wheat, lineFor } = await poSetup();

    await poService.receivePO(company.id, user.id, po.id, {
      locationId: location.id,
      lines: [
        { lineId: lineFor(wheat.id).id, quantity: 100, batchNumber: "WH-A" },
      ],
    });

    const err = await expectAppError(
      poService.receivePO(company.id, user.id, po.id, {
        locationId: location.id,
        lines: [
          { lineId: lineFor(wheat.id).id, quantity: 1, batchNumber: "WH-B" },
        ],
      }),
      400
    );
    expect(err.message).toMatch(/left to receive/i);
  });
});
