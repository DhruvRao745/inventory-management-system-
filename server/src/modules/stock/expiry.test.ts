/**
 * Expired stock must never be sold (BUG-10).
 *
 * ROOT CAUSE: expiry is a DATE and sellability is a STATUS, and nothing turned
 * the first into the second as time passed. A lot that went off last month was
 * still `status: AVAILABLE`, so it passed every filter — and FEFO, which sorts
 * by NEAREST EXPIRY FIRST, reached for it before anything else. The rule meant
 * to protect the customer was actively selecting the worst stock on the shelf.
 *
 * The fix judges against the clock at read time rather than by a nightly job
 * that flips statuses: a job that has not run yet leaves expired goods
 * sellable, and "is this expired?" has an exact answer at every instant
 * without one.
 *
 * TWO DIFFERENT CASES, both tested here:
 *
 *   arrived expired  → recorded, but lands with status EXPIRED
 *   expired on the shelf → status still says AVAILABLE; the DATE is what
 *                          disqualifies it. This is the reported bug, and the
 *                          harder one, because nothing in the row looks wrong.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import * as stockService from "./stock.service.js";
import * as invService from "../invoices/inv.service.js";
import * as posService from "../pos/pos.service.js";
import { availableQuantity } from "../../lib/reservations.js";
import { planAllocation } from "./batch.service.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";

const SOON = "2099-06-30";
const LATER = "2099-12-31";

async function shop() {
  const base = await createTestCompany();

  await prisma.product.update({
    where: { id: base.product.id },
    data: { tracksBatch: true, batchStrategy: "FEFO" },
  });

  const receive = (batchNumber: string, quantity: number, expiry?: string) =>
    stockService.createMovement(base.company.id, base.user.id, {
      productId: base.product.id,
      locationId: base.location.id,
      type: "PURCHASE",
      quantity,
      unitCost: 20,
      batchNumber,
      ...(expiry ? { expiryDate: new Date(expiry).toISOString() } : {}),
    } as Parameters<typeof stockService.createMovement>[2]);

  /**
   * Move a lot's expiry into the past — the shelf-life equivalent of letting
   * time pass. Its STATUS is deliberately left as AVAILABLE, because that is
   * exactly the state the bug lived in: nothing about the row looks wrong.
   */
  const age = (batchNumber: string) =>
    prisma.inventoryBatch.updateMany({
      where: { companyId: base.company.id, batchNumber },
      data: { expiryDate: new Date("2020-01-01") },
    });

  const sell = (quantity: number) =>
    posService.posSale(base.company.id, base.user.id, {
      locationId: base.location.id,
      lines: [{ productId: base.product.id, quantity }],
    } as Parameters<typeof posService.posSale>[2]);

  const quantities = () =>
    availableQuantity(prisma, base.company.id, {
      productId: base.product.id,
      locationId: base.location.id,
    });

  const level = async () => {
    const rows = await stockService.stockLevels(base.company.id, {
      productId: base.product.id,
    });
    return rows[0]!;
  };

  const lots = async () => {
    const rows = await prisma.inventoryBatch.findMany({
      where: { companyId: base.company.id, productId: base.product.id },
    });
    return Object.fromEntries(
      rows.map((r) => [r.batchNumber, Number(r.remainingQuantity)])
    ) as Record<string, number>;
  };

  const plan = (quantity: number) =>
    planAllocation(
      prisma as unknown as Parameters<typeof planAllocation>[0],
      base.company.id,
      base.product.id,
      base.location.id,
      new Prisma.Decimal(quantity),
      "FEFO"
    );

  return { ...base, receive, age, sell, quantities, level, lots, plan };
}

describe("expired stock is never sellable", () => {
  beforeEach(resetDb);

  it("a lot within its date sells normally", async () => {
    const { receive, sell, quantities, lots } = await shop();
    await receive("GOOD", 10, LATER);

    expect(Number((await quantities()).available)).toBe(10);
    await sell(4);
    expect((await lots()).GOOD).toBe(6);
  });

  it("THE BUG: stock that expired on the shelf cannot be sold", async () => {
    const { receive, age, sell, quantities } = await shop();
    await receive("OLD", 10, SOON);
    await age("OLD"); // time passes

    const q = await quantities();
    expect(Number(q.onHand)).toBe(10); // still owned
    expect(Number(q.expired)).toBe(10);
    expect(Number(q.available)).toBe(0); // and unsellable

    await expect(sell(1)).rejects.toThrow(/expir|Not enough stock/i);
  });

  it("mixed lots: only the good stock is sold", async () => {
    const { receive, age, sell, quantities, lots } = await shop();
    await receive("OLD", 6, SOON);
    await receive("GOOD", 4, LATER);
    await age("OLD");

    expect(Number((await quantities()).available)).toBe(4);

    await sell(4);
    const after = await lots();
    expect(after.GOOD).toBe(0); // the good stock went
    expect(after.OLD).toBe(6); // the expired stock is untouched
  });

  it("FEFO never picks an expired lot, though it expires soonest", async () => {
    // The heart of it. FEFO sorts by nearest expiry, so before the fix the
    // expired lot was not merely eligible — it was FIRST in the queue.
    const { receive, age, plan } = await shop();
    await receive("OLD", 50, SOON);
    await receive("GOOD", 50, LATER);
    await age("OLD");

    const allocation = await plan(10);
    expect(allocation.map((p) => p.batchNumber)).toEqual(["GOOD"]);
  });

  it("all lots expired: the sale is rejected, and the message says why", async () => {
    const { receive, age, sell } = await shop();
    await receive("OLD-A", 5, SOON);
    await receive("OLD-B", 5, SOON);
    await age("OLD-A");
    await age("OLD-B");

    const err = await sell(1).then(
      () => null,
      (e) => e as Error
    );
    expect(err).toBeTruthy();
    expect(err!.message).toMatch(/expir/i);
  });

  it("expired stock stays in inventory and reporting — never discarded", async () => {
    const { company, product, receive, age, level } = await shop();
    await receive("OLD", 8, SOON);
    await receive("GOOD", 2, LATER);
    await age("OLD");

    // Every row is still there: we own these goods and a stocktake will find
    // them, so deleting them would make the system disagree with the shelf.
    expect(
      await prisma.stockMovement.count({
        where: { companyId: company.id, productId: product.id },
      })
    ).toBe(2);
    expect(
      await prisma.inventoryBatch.count({ where: { companyId: company.id } })
    ).toBe(2);

    const row = await level();
    expect(Number(row.quantity)).toBe(10); // owned
    expect(Number(row.available)).toBe(2); // sellable
    expect(Number(row.expiredByDate)).toBe(8); // and the gap is NAMED
  });

  it("goods received ALREADY expired are recorded, but never sellable", async () => {
    // Receiving them stays possible — a short-dated delivery is a real event,
    // and refusing to record it would leave the shelf holding stock the system
    // denies exists. What must not happen is them becoming sellable.
    const { receive, quantities, level } = await shop();
    await receive("DOA", 12, "2020-01-01");

    const q = await quantities();
    expect(Number(q.onHand)).toBe(12);
    expect(Number(q.available)).toBe(0);

    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { batchNumber: "DOA" },
    });
    expect(movement.status).toBe("EXPIRED");

    const lot = await prisma.inventoryBatch.findFirstOrThrow({
      where: { batchNumber: "DOA" },
    });
    expect(lot.status).toBe("EXPIRED");

    const row = await level();
    expect(Number(row.quantity)).toBe(12); // owned and visible
    expect(Number(row.expired)).toBe(12);
  });

  it("an ordinary invoice is blocked by expiry just like POS", async () => {
    // The check lives in the shared availability function, so both doors get
    // it. A guard on only one of them is not a guard.
    const { company, user, product, location, receive, age } = await shop();
    await receive("OLD", 10, SOON);
    await age("OLD");

    const draft = await invService.createInvoice(company.id, user.id, {
      customerName: "Counter",
      locationId: location.id,
      lines: [{ productId: product.id, quantity: 3, unitPrice: 50 }],
    } as Parameters<typeof invService.createInvoice>[2]);

    await expect(
      invService.issueInvoice(company.id, user.id, draft.id)
    ).rejects.toThrow(/expir|Not enough stock/i);
  });

  it("an outgoing adjustment cannot draw on expired stock either", async () => {
    // Otherwise expired goods could be walked into sellable stock through the
    // back door, one reclassification at a time.
    const { company, user, product, location, receive, age } = await shop();
    await receive("OLD", 10, SOON);
    await age("OLD");

    await expect(
      stockService.createMovement(company.id, user.id, {
        productId: product.id,
        locationId: location.id,
        type: "ADJUSTMENT",
        quantity: -5,
        status: "AVAILABLE",
      } as Parameters<typeof stockService.createMovement>[2])
    ).rejects.toThrow(/Not enough/i);
  });

  it("a return of expired goods comes back non-sellable", async () => {
    // Returns respect the same rule: goods sent back after their date are
    // owned again, but they do not rejoin sellable stock.
    const { company, user, product, location } = await shop();

    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "RETURN_IN",
      quantity: 5,
      batchNumber: "BACK",
      expiryDate: new Date("2020-01-01").toISOString(),
    } as Parameters<typeof stockService.createMovement>[2]);

    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { batchNumber: "BACK" },
    });
    expect(movement.status).toBe("EXPIRED");

    const q = await availableQuantity(prisma, company.id, {
      productId: product.id,
      locationId: location.id,
    });
    expect(Number(q.onHand)).toBe(5);
    expect(Number(q.available)).toBe(0);
  });
});
