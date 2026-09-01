/**
 * Inventory statuses (P2-2).
 *
 * The distinction these tests defend: stock can be OWNED without being
 * SELLABLE.
 *
 *     On hand   = SUM(all movements)                    — what we own
 *     Sellable  = SUM(movements WHERE status=AVAILABLE)  — what we may sell
 *     Available = Sellable − Reserved                    — what's still free
 *
 * Before this, damaged returns never entered the ledger at all. They were
 * noted on the return document and disappeared: not counted, not valued,
 * invisible to a stocktake. The warehouse held goods the system denied
 * existed, and the first person to discover that was whoever did the count and
 * got a variance nobody could explain.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import * as stockService from "./stock.service.js";
import * as invService from "../invoices/inv.service.js";
import * as returnService from "../returns/return.service.js";
import { availableQuantity } from "../../lib/reservations.js";
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

async function shop() {
  const base = await createTestCompany();

  const move = (
    type: "PURCHASE" | "SALE" | "ADJUSTMENT",
    quantity: number,
    status?: "AVAILABLE" | "DAMAGED" | "QUARANTINE" | "EXPIRED"
  ) =>
    stockService.createMovement(base.company.id, base.user.id, {
      productId: base.product.id,
      locationId: base.location.id,
      type,
      quantity,
      ...(status ? { status } : {}),
      ...(type === "PURCHASE" ? { unitCost: 10 } : {}),
    } as Parameters<typeof stockService.createMovement>[2]);

  const avail = () =>
    availableQuantity(prisma, base.company.id, {
      productId: base.product.id,
      locationId: base.location.id,
    });

  const level = () =>
    stockService
      .stockLevels(base.company.id, { take: 50, skip: 0 } as never)
      .then((rows) => rows.find((r) => r.product.id === base.product.id)!);

  return { ...base, move, avail, level };
}

describe("statuses — owned vs sellable", () => {
  beforeEach(resetDb);

  it("quarantined stock is owned but not sellable", async () => {
    // THE test. On hand counts it; available does not.
    const { move, avail } = await shop();
    await move("PURCHASE", 10);
    await move("PURCHASE", 5, "QUARANTINE");

    const { onHand, sellable, available } = await avail();
    expect(Number(onHand)).toBe(15); // we own 15
    expect(Number(sellable)).toBe(10); // we may sell 10
    expect(Number(available)).toBe(10);
  });

  it("refuses to sell more than the sellable stock, even with plenty on hand", async () => {
    const { move } = await shop();
    await move("PURCHASE", 2);
    await move("PURCHASE", 100, "DAMAGED");

    // 102 on hand, but only 2 that anyone may sell.
    await expectAppError(move("SALE", 5), 400);
  });

  it("a sale draws only from available stock", async () => {
    const { move, avail } = await shop();
    await move("PURCHASE", 10);
    await move("PURCHASE", 5, "DAMAGED");
    await move("SALE", 4);

    const { onHand, sellable } = await avail();
    expect(Number(onHand)).toBe(11); // 15 − 4
    expect(Number(sellable)).toBe(6); // 10 − 4; the damaged 5 untouched
  });

  it("stock levels break the shelf down by condition", async () => {
    const { move, level } = await shop();
    await move("PURCHASE", 10);
    await move("PURCHASE", 3, "DAMAGED");
    await move("PURCHASE", 2, "QUARANTINE");

    const row = await level();
    expect(Number(row.quantity)).toBe(15); // on hand, all conditions
    expect(Number(row.sellable)).toBe(10);
    expect(Number(row.damaged)).toBe(3);
    expect(Number(row.quarantine)).toBe(2);
    expect(Number(row.available)).toBe(10);
  });

  it("low stock is judged on available, not on hand", async () => {
    // A shelf full of broken goods is still a shelf that needs reordering.
    const { product, move, level } = await shop();
    await prisma.product.update({
      where: { id: product.id },
      data: { lowStockThreshold: 5 },
    });
    await move("PURCHASE", 2);
    await move("PURCHASE", 100, "DAMAGED");

    expect((await level()).lowStock).toBe(true);
  });
});

describe("statuses — reclassification is an event, not an edit", () => {
  beforeEach(resetDb);

  it("moving quarantine to available writes TWO movements and changes no total", async () => {
    // Nothing physically happened — the goods were only re-labelled — so on
    // hand must not move. What changes is which bucket holds them.
    const { company, user, product, location, move, avail } = await shop();
    await move("PURCHASE", 10, "QUARANTINE");

    const before = await prisma.stockMovement.count({
      where: { companyId: company.id },
    });

    await stockService.reclassifyStock(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      quantity: 6,
      fromStatus: "QUARANTINE",
      toStatus: "AVAILABLE",
    });

    expect(
      await prisma.stockMovement.count({ where: { companyId: company.id } })
    ).toBe(before + 2); // a pair, not an update

    const { onHand, sellable } = await avail();
    expect(Number(onHand)).toBe(10); // unchanged — nothing moved physically
    expect(Number(sellable)).toBe(6); // released
  });

  it("never rewrites the original movement", async () => {
    // The ledger is append-only (P0). If reclassifying edited history, the
    // record that these units were ever quarantined would simply cease to
    // exist, and nobody could tell an inspection had happened.
    const { company, user, product, location, move } = await shop();
    const original = await move("PURCHASE", 10, "QUARANTINE");

    await stockService.reclassifyStock(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      quantity: 10,
      fromStatus: "QUARANTINE",
      toStatus: "AVAILABLE",
    });

    const still = await prisma.stockMovement.findUnique({
      where: { id: original.id },
    });
    expect(still!.status).toBe("QUARANTINE"); // untouched
    expect(Number(still!.quantity)).toBe(10);
  });

  it("refuses to release more than the source bucket holds", async () => {
    // You cannot release 5 from quarantine when only 2 are quarantined, no
    // matter how much good stock is sitting beside it.
    const { company, user, product, location, move } = await shop();
    await move("PURCHASE", 100); // plenty of good stock
    await move("PURCHASE", 2, "QUARANTINE");

    const err = await expectAppError(
      stockService.reclassifyStock(company.id, user.id, {
        productId: product.id,
        locationId: location.id,
        quantity: 5,
        fromStatus: "QUARANTINE",
        toStatus: "AVAILABLE",
      }),
      400
    );
    expect(err.message).toMatch(/quarantine/i);
  });

  it("refuses to quarantine stock that is already reserved", async () => {
    // Otherwise the promise breaks silently: the invoice still says 5, and the
    // shelf can no longer supply them.
    const { company, user, product, location, move } = await shop();
    await move("PURCHASE", 10);
    await invService.createInvoice(company.id, user.id, {
      customerName: "Walk-in",
      locationId: location.id,
      lines: [{ productId: product.id, quantity: 8, unitPrice: 20 }],
    } as Parameters<typeof invService.createInvoice>[2]);

    const err = await expectAppError(
      stockService.reclassifyStock(company.id, user.id, {
        productId: product.id,
        locationId: location.id,
        quantity: 5,
        fromStatus: "AVAILABLE",
        toStatus: "QUARANTINE",
      }),
      400
    );
    expect(err.message).toMatch(/reserved/i);
  });

  it("allows reclassifying the unreserved remainder", async () => {
    const { company, user, product, location, move, avail } = await shop();
    await move("PURCHASE", 10);
    await invService.createInvoice(company.id, user.id, {
      customerName: "Walk-in",
      locationId: location.id,
      lines: [{ productId: product.id, quantity: 8, unitPrice: 20 }],
    } as Parameters<typeof invService.createInvoice>[2]);

    await stockService.reclassifyStock(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      quantity: 2, // exactly what's free
      fromStatus: "AVAILABLE",
      toStatus: "DAMAGED",
    });

    const { onHand, sellable } = await avail();
    expect(Number(onHand)).toBe(10);
    expect(Number(sellable)).toBe(8);
  });

  it("rejects a no-op reclassification", async () => {
    const { company, user, product, location, move } = await shop();
    await move("PURCHASE", 10);
    await expectAppError(
      stockService.reclassifyStock(company.id, user.id, {
        productId: product.id,
        locationId: location.id,
        quantity: 5,
        fromStatus: "AVAILABLE",
        toStatus: "AVAILABLE",
      }),
      400
    );
  });
});

describe("statuses — damaged returns finally land somewhere", () => {
  beforeEach(resetDb);

  async function soldThenReturned(condition: "SELLABLE" | "DAMAGED") {
    const base = await shop();
    await base.move("PURCHASE", 10);

    const inv = await invService.createInvoice(
      base.company.id,
      base.user.id,
      {
        customerName: "Walk-in",
        locationId: base.location.id,
        lines: [{ productId: base.product.id, quantity: 5, unitPrice: 20 }],
      } as Parameters<typeof invService.createInvoice>[2]
    );
    await invService.issueInvoice(base.company.id, base.user.id, inv.id);

    const full = await invService.getInvoice(base.company.id, inv.id);
    const ret = await returnService.createReturn(
      base.company.id,
      base.user.id,
      {
        invoiceId: inv.id,
        lines: [
          {
            invoiceLineId: full.lines[0]!.id,
            quantity: 2,
            condition,
            restock: condition === "SELLABLE",
          },
        ],
      } as Parameters<typeof returnService.createReturn>[2]
    );
    await returnService.approveReturn(base.company.id, base.user.id, ret.id);
    await returnService.receiveReturn(base.company.id, base.user.id, ret.id);

    return base;
  }

  it("a sellable return goes back into sellable stock", async () => {
    const base = await soldThenReturned("SELLABLE");
    const { onHand, sellable } = await base.avail();
    expect(Number(onHand)).toBe(7); // 10 − 5 + 2
    expect(Number(sellable)).toBe(7);
  });

  it("a damaged return is OWNED but not sellable", async () => {
    // The change from P1: these units used to vanish entirely.
    const base = await soldThenReturned("DAMAGED");
    const { onHand, sellable, available } = await base.avail();
    expect(Number(onHand)).toBe(7); // we own them — a stocktake will find them
    expect(Number(sellable)).toBe(5); // but they can never be sold
    expect(Number(available)).toBe(5);
  });

  it("the damaged units show in the shelf breakdown", async () => {
    const base = await soldThenReturned("DAMAGED");
    const row = await base.level();
    expect(Number(row.damaged)).toBe(2);
    expect(Number(row.sellable)).toBe(5);
  });
});

describe("statuses — batch allocation skips non-sellable lots", () => {
  beforeEach(resetDb);

  it("FEFO ignores a quarantined lot even when it expires soonest", async () => {
    // The sharpest version of the risk: FEFO reaches for the NEAREST expiry
    // first, so a quarantined short-dated lot is exactly the one it would grab.
    const base = await createTestCompany();
    await prisma.product.update({
      where: { id: base.product.id },
      data: { tracksBatch: true },
    });

    const receive = (
      batchNumber: string,
      quantity: number,
      days: number,
      status?: "AVAILABLE" | "QUARANTINE"
    ) =>
      stockService.createMovement(base.company.id, base.user.id, {
        productId: base.product.id,
        locationId: base.location.id,
        type: "PURCHASE",
        quantity,
        unitCost: 10,
        batchNumber,
        expiryDate: new Date(Date.now() + days * 86_400_000).toISOString(),
        ...(status ? { status } : {}),
      } as Parameters<typeof stockService.createMovement>[2]);

    await receive("SHORT-DATED", 10, 5, "QUARANTINE"); // expires first
    await receive("GOOD", 10, 90); // expires much later

    await stockService.createMovement(base.company.id, base.user.id, {
      productId: base.product.id,
      locationId: base.location.id,
      type: "SALE",
      quantity: 4,
    } as Parameters<typeof stockService.createMovement>[2]);

    const quarantined = await prisma.inventoryBatch.findFirst({
      where: { companyId: base.company.id, batchNumber: "SHORT-DATED" },
    });
    const good = await prisma.inventoryBatch.findFirst({
      where: { companyId: base.company.id, batchNumber: "GOOD" },
    });

    expect(Number(quarantined!.remainingQuantity)).toBe(10); // untouched
    expect(Number(good!.remainingQuantity)).toBe(6); // 10 − 4
  });

  it("the same batch number in two conditions stays two lots", async () => {
    // Merging them would let quarantined units be sold under cover of the good
    // ones sharing their batch number.
    const base = await createTestCompany();
    await prisma.product.update({
      where: { id: base.product.id },
      data: { tracksBatch: true },
    });

    const receive = (
      quantity: number,
      status?: "AVAILABLE" | "QUARANTINE"
    ) =>
      stockService.createMovement(base.company.id, base.user.id, {
        productId: base.product.id,
        locationId: base.location.id,
        type: "PURCHASE",
        quantity,
        unitCost: 10,
        batchNumber: "B1",
        ...(status ? { status } : {}),
      } as Parameters<typeof stockService.createMovement>[2]);

    await receive(10);
    await receive(4, "QUARANTINE");

    const lots = await prisma.inventoryBatch.findMany({
      where: { companyId: base.company.id, batchNumber: "B1" },
    });
    expect(lots).toHaveLength(2);
    expect(
      lots.find((l) => l.status === "AVAILABLE")!.remainingQuantity.toString()
    ).toBe("10");
  });
});

describe("statuses — valuation still counts what we own", () => {
  beforeEach(resetDb);

  it("damaged stock keeps its value on the books", async () => {
    // The company still owns it. Excluding damaged goods from valuation would
    // quietly write off inventory sitting in the warehouse.
    const { company, product, move } = await shop();
    await move("PURCHASE", 10);
    await move("PURCHASE", 5, "DAMAGED");

    const p = await prisma.product.findUnique({ where: { id: product.id } });
    expect(Number(p!.stockValue)).toBeGreaterThan(0);

    const totalOnHand = await prisma.stockMovement.aggregate({
      where: { companyId: company.id, productId: product.id },
      _sum: { quantity: true },
    });
    expect(Number(totalOnHand._sum.quantity)).toBe(15);
  });

  it("reclassifying does not move the weighted average", async () => {
    // Nothing was bought, sold or lost — only re-labelled. Revaluing here
    // would invent a cost change out of an administrative act.
    const { company, user, product, location, move } = await shop();
    await move("PURCHASE", 10);

    const before = await prisma.product.findUnique({
      where: { id: product.id },
    });

    await stockService.reclassifyStock(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      quantity: 4,
      fromStatus: "AVAILABLE",
      toStatus: "DAMAGED",
    });

    const after = await prisma.product.findUnique({ where: { id: product.id } });
    expect(after!.avgCost.toString()).toBe(before!.avgCost.toString());
    expect(after!.stockValue.toString()).toBe(before!.stockValue.toString());
  });
});
