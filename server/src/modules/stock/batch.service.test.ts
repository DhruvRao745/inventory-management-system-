/**
 * Batch inventory + FEFO (P1-1).
 *
 * The rule under test: when stock leaves, the RIGHT units leave. For anything
 * perishable that means nearest-expiry-first, because the alternative is
 * shipping the December stock while the September stock quietly rots.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import * as stockService from "./stock.service.js";
import * as batchService from "./batch.service.js";
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

/** A batch-tracked product, plus a helper to receive lots into it. */
async function batchSetup(strategy: "FEFO" | "FIFO" = "FEFO") {
  const base = await createTestCompany();
  const product = await prisma.product.create({
    data: {
      companyId: base.company.id,
      sku: "MILK-1L",
      name: "Milk 1L",
      costPrice: 20,
      sellingPrice: 35,
      tracksBatch: true,
      batchStrategy: strategy,
    },
  });

  const receive = (batchNumber: string, quantity: number, expiry?: string) =>
    stockService.createMovement(base.company.id, base.user.id, {
      productId: product.id,
      locationId: base.location.id,
      type: "PURCHASE",
      quantity,
      batchNumber,
      ...(expiry ? { expiryDate: new Date(expiry).toISOString() } : {}),
    } as Parameters<typeof stockService.createMovement>[2]);

  const sell = (quantity: number) =>
    stockService.createMovement(base.company.id, base.user.id, {
      productId: product.id,
      locationId: base.location.id,
      type: "SALE",
      quantity,
    } as Parameters<typeof stockService.createMovement>[2]);

  const remaining = async () => {
    const rows = await prisma.inventoryBatch.findMany({
      where: { companyId: base.company.id, productId: product.id },
      orderBy: { batchNumber: "asc" },
    });
    return Object.fromEntries(
      rows.map((r) => [r.batchNumber, Number(r.remainingQuantity)])
    ) as Record<string, number>;
  };

  return { ...base, product, receive, sell, remaining };
}

describe("batch inventory — FEFO allocation", () => {
  beforeEach(resetDb);

  it("PRD acceptance: 100 @ Sep + 100 @ Dec, sell 120 → A:0, B:80", async () => {
    const { receive, sell, remaining } = await batchSetup("FEFO");

    // Deliberately received in the WRONG order: the December lot arrives
    // first. FEFO must sort by expiry, not by arrival.
    await receive("B", 100, "2026-12-31");
    await receive("A", 100, "2026-09-30");

    await sell(120);

    expect(await remaining()).toEqual({ A: 0, B: 80 });
  });

  it("consumes a single batch when it covers the whole sale", async () => {
    const { receive, sell, remaining } = await batchSetup();
    await receive("A", 100, "2026-09-30");
    await receive("B", 100, "2026-12-31");

    await sell(40);

    expect(await remaining()).toEqual({ A: 60, B: 100 });
  });

  it("batches with NO expiry are consumed LAST, not first", async () => {
    // The trap: SQL sorts NULLs first on ASC by default, which would ship
    // never-expiring stock ahead of stock expiring next week — backwards.
    const { receive, sell, remaining } = await batchSetup("FEFO");
    await receive("NOEXPIRY", 100);
    await receive("SOON", 50, "2026-09-01");

    await sell(60);

    expect(await remaining()).toEqual({ SOON: 0, NOEXPIRY: 90 });
  });

  it("FIFO products consume oldest-received first, ignoring expiry", async () => {
    const { receive, sell, remaining } = await batchSetup("FIFO");
    await receive("FIRST", 30, "2026-12-31"); // later expiry, arrived first
    await receive("SECOND", 30, "2026-09-30");

    await sell(40);

    expect(await remaining()).toEqual({ FIRST: 0, SECOND: 20 });
  });

  it("spans three batches when needed", async () => {
    const { receive, sell, remaining } = await batchSetup();
    await receive("A", 10, "2026-01-31");
    await receive("B", 10, "2026-02-28");
    await receive("C", 10, "2026-03-31");

    await sell(25);

    expect(await remaining()).toEqual({ A: 0, B: 0, C: 5 });
  });

  it("refuses to sell more than the batches hold, and writes nothing", async () => {
    const { company, product, location, receive, sell, remaining } =
      await batchSetup();
    await receive("A", 10, "2026-09-30");

    await expectAppError(sell(11), 400);

    // The ledger and the batch must BOTH be untouched — a half-applied
    // allocation would be worse than the refusal.
    expect(await remaining()).toEqual({ A: 10 });
    expect(
      Number(await stockService.getStockLevel(company.id, product.id, location.id))
    ).toBe(10);
  });

  it("re-receiving the same batch number tops up the existing lot", async () => {
    const { receive, remaining } = await batchSetup();
    await receive("SAME", 10, "2026-09-30");
    await receive("SAME", 5, "2026-09-30");

    expect(await remaining()).toEqual({ SAME: 15 });

    const lots = await prisma.inventoryBatch.findMany({
      where: { batchNumber: "SAME" },
    });
    expect(lots).toHaveLength(1); // topped up, not duplicated
    expect(Number(lots[0]!.receivedQuantity)).toBe(15);
  });

  it("requires a batch number on incoming stock for tracked products", async () => {
    const { company, user, product, location } = await batchSetup();
    await expectAppError(
      stockService.createMovement(company.id, user.id, {
        productId: product.id,
        locationId: location.id,
        type: "PURCHASE",
        quantity: 10,
      } as Parameters<typeof stockService.createMovement>[2]),
      400
    );
  });

  it("untracked products are completely unaffected", async () => {
    // The existing behaviour must not change for anyone who hasn't opted in.
    const { company, user, location, product } = await createTestCompany();
    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "PURCHASE",
      quantity: 50,
    } as Parameters<typeof stockService.createMovement>[2]);
    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "SALE",
      quantity: 20,
    } as Parameters<typeof stockService.createMovement>[2]);

    expect(
      Number(await stockService.getStockLevel(company.id, product.id, location.id))
    ).toBe(30);
    expect(await prisma.inventoryBatch.count()).toBe(0);
  });
});

describe("batch inventory — ledger agreement", () => {
  beforeEach(resetDb);

  it("batch remainder always equals the ledger total", async () => {
    // The two must never disagree. If they do, one of them is lying about
    // what's on the shelf.
    const { company, product, location, receive, sell, remaining } =
      await batchSetup();
    await receive("A", 100, "2026-09-30");
    await receive("B", 50, "2026-12-31");
    await sell(120);

    const batchTotal = Object.values(await remaining()).reduce(
      (a, b) => a + b,
      0
    );
    const ledger = Number(
      await stockService.getStockLevel(company.id, product.id, location.id)
    );
    expect(batchTotal).toBe(ledger);
    expect(ledger).toBe(30);
  });

  it("records which lots a movement drew from", async () => {
    const { receive, sell } = await batchSetup();
    await receive("A", 100, "2026-09-30");
    await receive("B", 100, "2026-12-31");
    const sale = await sell(120);

    const allocations = await prisma.stockMovementBatch.findMany({
      where: { movementId: sale.id },
      include: { batch: true },
      orderBy: { batch: { batchNumber: "asc" } },
    });

    // One SALE movement, two lots behind it — the ledger stays one row per
    // business event while still being fully batch-attributable.
    expect(allocations).toHaveLength(2);
    expect(Number(allocations[0]!.quantity)).toBe(-100); // signed: consumed
    expect(allocations[0]!.batch.batchNumber).toBe("A");
    expect(Number(allocations[1]!.quantity)).toBe(-20);
  });
});

describe("batch inventory — transfers and cancellations", () => {
  beforeEach(resetDb);

  it("a transfer carries batch identity to the destination", async () => {
    const { company, user, product, location, receive } = await batchSetup();
    const dest = await prisma.location.create({
      data: { companyId: company.id, name: "Cold Store" },
    });
    await receive("A", 100, "2026-09-30");

    await stockService.transfer(company.id, user.id, {
      productId: product.id,
      fromLocationId: location.id,
      toLocationId: dest.id,
      quantity: 30,
    } as Parameters<typeof stockService.transfer>[2]);

    const atSource = await prisma.inventoryBatch.findFirst({
      where: { productId: product.id, locationId: location.id },
    });
    const atDest = await prisma.inventoryBatch.findFirst({
      where: { productId: product.id, locationId: dest.id },
    });

    expect(Number(atSource!.remainingQuantity)).toBe(70);
    expect(Number(atDest!.remainingQuantity)).toBe(30);
    // Crucially the expiry travels with it — moving shelves must not reset
    // how long the stock is good for.
    expect(atDest!.batchNumber).toBe("A");
    expect(atDest!.expiryDate?.toISOString()).toBe(
      atSource!.expiryDate?.toISOString()
    );
  });

  it("cancelling an issued invoice returns stock to its original lots", async () => {
    const { company, user, product, location, receive, remaining } =
      await batchSetup();
    await receive("A", 100, "2026-09-30");
    await receive("B", 100, "2026-12-31");

    const inv = await invService.createInvoice(company.id, user.id, {
      customerName: "Walk-in",
      locationId: location.id,
      lines: [{ productId: product.id, quantity: 120, unitPrice: 35 }],
    } as Parameters<typeof invService.createInvoice>[2]);

    await invService.issueInvoice(company.id, user.id, inv.id);
    expect(await remaining()).toEqual({ A: 0, B: 80 });

    await invService.cancelInvoice(company.id, user.id, inv.id);

    // Back exactly where it came from — NOT 120 dumped into whichever lot
    // happened to sort first, which would launder September stock into
    // December stock.
    expect(await remaining()).toEqual({ A: 100, B: 100 });
    expect(
      Number(await stockService.getStockLevel(company.id, product.id, location.id))
    ).toBe(200);
  });

  it("issuing an invoice for a batch product allocates FEFO", async () => {
    const { company, user, product, location, receive, remaining } =
      await batchSetup();
    await receive("LATER", 50, "2026-12-31");
    await receive("SOONER", 50, "2026-09-30");

    const inv = await invService.createInvoice(company.id, user.id, {
      customerName: "Walk-in",
      locationId: location.id,
      lines: [{ productId: product.id, quantity: 60, unitPrice: 35 }],
    } as Parameters<typeof invService.createInvoice>[2]);
    await invService.issueInvoice(company.id, user.id, inv.id);

    expect(await remaining()).toEqual({ SOONER: 0, LATER: 40 });
  });
});

describe("batch inventory — concurrency (builds on P0 locks)", () => {
  beforeEach(resetDb);

  it("simultaneous sales cannot over-allocate a batch", async () => {
    // Batch allocation is a read-then-write on remainingQuantity — the exact
    // shape of the P0 oversell bug. It is safe only because it happens inside
    // lockStock, which is keyed on (company, product, location).
    const { company, product, location, receive, sell } = await batchSetup();
    await receive("ONLY", 10, "2026-09-30");

    const results = await Promise.allSettled([sell(8), sell(7)]);
    const ok = results.filter((r) => r.status === "fulfilled").length;

    expect(ok).toBe(1);

    const batch = await prisma.inventoryBatch.findFirst({
      where: { batchNumber: "ONLY" },
    });
    expect(Number(batch!.remainingQuantity)).toBeGreaterThanOrEqual(0);
    expect(Number(batch!.remainingQuantity)).toBe(
      Number(await stockService.getStockLevel(company.id, product.id, location.id))
    );
  });
});
