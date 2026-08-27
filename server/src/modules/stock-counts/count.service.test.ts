/**
 * Stock counting (P1-9).
 *
 * PRD §12: "Never silently overwrite system stock." Completion writes
 * ADJUSTMENT movements, so a correction is an event with a person attached —
 * not a number that quietly changed.
 *
 * The subtlest test in this file is the last one in "the delta rule": it's the
 * only place the difference between "set stock to the count" and "apply the
 * variance" actually shows itself.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import * as service from "./count.service.js";
import * as stockService from "../stock/stock.service.js";
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

/** A location holding 100 units, ready to count. */
async function countSetup(startingStock = 100) {
  const base = await createTestCompany();
  if (startingStock > 0) {
    await stockService.createMovement(base.company.id, base.user.id, {
      productId: base.product.id,
      locationId: base.location.id,
      type: "PURCHASE",
      quantity: startingStock,
      unitCost: 10,
    } as Parameters<typeof stockService.createMovement>[2]);
  }

  const level = () =>
    stockService
      .getStockLevel(base.company.id, base.product.id, base.location.id)
      .then(Number);

  /** Prepare → start → record one figure. Returns the count. */
  const countTo = async (found: number) => {
    const count = await service.createCount(base.company.id, base.user.id, {
      locationId: base.location.id,
    } as Parameters<typeof service.createCount>[2]);
    await service.startCounting(base.company.id, count.id);
    await service.recordCount(base.company.id, count.id, {
      itemId: count.items[0]!.id,
      countedQuantity: found,
    } as Parameters<typeof service.recordCount>[2]);
    return count;
  };

  return { ...base, level, countTo };
}

describe("stock counting — the sheet", () => {
  beforeEach(resetDb);

  it("snapshots what the system believes", async () => {
    const { company, user, location, countTo } = await countSetup(100);
    const count = await service.createCount(company.id, user.id, {
      locationId: location.id,
    } as Parameters<typeof service.createCount>[2]);

    expect(count.status).toBe("OPEN");
    expect(count.items).toHaveLength(1);
    expect(Number(count.items[0]!.expectedQuantity)).toBe(100);
    expect(count.items[0]!.countedQuantity).toBeNull();
    void countTo;
  });

  it("skips products with no stock by default", async () => {
    // A sheet listing everything the shop has never carried is a sheet nobody
    // will finish.
    const { company, user, location } = await countSetup(100);
    await prisma.product.create({
      data: {
        companyId: company.id,
        sku: "NEVER-STOCKED",
        name: "Never Stocked",
        costPrice: 1,
        sellingPrice: 2,
      },
    });

    const count = await service.createCount(company.id, user.id, {
      locationId: location.id,
    } as Parameters<typeof service.createCount>[2]);
    expect(count.items).toHaveLength(1);
  });

  it("includes a NAMED product even at zero stock", async () => {
    // "We think there are none — confirm that" is a legitimate request.
    const { company, user, location } = await countSetup(100);
    const empty = await prisma.product.create({
      data: {
        companyId: company.id,
        sku: "EMPTY",
        name: "Empty Shelf Item",
        costPrice: 1,
        sellingPrice: 2,
      },
    });

    const count = await service.createCount(company.id, user.id, {
      locationId: location.id,
      productIds: [empty.id],
    } as Parameters<typeof service.createCount>[2]);

    expect(count.items).toHaveLength(1);
    expect(count.items[0]!.productId).toBe(empty.id);
    expect(Number(count.items[0]!.expectedQuantity)).toBe(0);
  });

  it("refuses an empty sheet", async () => {
    const base = await createTestCompany();
    await expectAppError(
      service.createCount(base.company.id, base.user.id, {
        locationId: base.location.id,
      } as Parameters<typeof service.createCount>[2]),
      400
    );
  });

  it("reports variance without storing it", async () => {
    const { company, countTo } = await countSetup(100);
    const count = await countTo(95);

    const fresh = await service.getCount(company.id, count.id);
    expect(Number(fresh.items[0]!.variance)).toBe(-5);
  });

  it("variance is null until someone actually counts", async () => {
    // "Nobody has looked" is different from "counted zero".
    const { company, user, location } = await countSetup(100);
    const count = await service.createCount(company.id, user.id, {
      locationId: location.id,
    } as Parameters<typeof service.createCount>[2]);
    expect(count.items[0]!.variance).toBeNull();
  });
});

describe("stock counting — the delta rule (PRD §12)", () => {
  beforeEach(resetDb);

  it("a shortfall writes a NEGATIVE adjustment, not an overwrite", async () => {
    const { company, user, level, countTo } = await countSetup(100);
    const count = await countTo(95);

    await service.submitForReview(company.id, count.id);
    await service.completeCount(company.id, user.id, count.id);

    expect(await level()).toBe(95);

    // The correction is an EVENT, with a person and an explanation.
    const adj = await prisma.stockMovement.findFirst({
      where: { companyId: company.id, type: "ADJUSTMENT" },
    });
    expect(Number(adj!.quantity)).toBe(-5);
    expect(adj!.reference).toBe("CNT-0001");
    expect(adj!.createdById).toBe(user.id);
    expect(adj!.note).toContain("expected 100");
    expect(adj!.note).toContain("counted 95");
  });

  it("found stock writes a POSITIVE adjustment", async () => {
    const { company, user, level, countTo } = await countSetup(100);
    const count = await countTo(103);
    await service.submitForReview(company.id, count.id);
    await service.completeCount(company.id, user.id, count.id);

    expect(await level()).toBe(103);
    const adj = await prisma.stockMovement.findFirst({
      where: { companyId: company.id, type: "ADJUSTMENT" },
    });
    expect(Number(adj!.quantity)).toBe(3);
  });

  it("a matching line writes NOTHING", async () => {
    // There's no event to record when reality agreed with the system, and
    // zero-quantity movements would bury the real corrections.
    const { company, user, countTo } = await countSetup(100);
    const count = await countTo(100);
    await service.submitForReview(company.id, count.id);
    await service.completeCount(company.id, user.id, count.id);

    expect(
      await prisma.stockMovement.count({
        where: { companyId: company.id, type: "ADJUSTMENT" },
      })
    ).toBe(0);
  });

  it("⭐ a sale DURING the count is preserved, not erased", async () => {
    // THE test for the delta rule, and the only place the choice shows.
    //
    // Count 95 against an expected 100, then a genuine sale of 5 happens
    // before anyone completes the count.
    //   Set stock TO 95   → ledger 95, shelf 90 — the sale is erased.
    //   Apply variance −5 → ledger 90 — correct.
    const { company, user, product, location, level, countTo } =
      await countSetup(100);
    const count = await countTo(95);

    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "SALE",
      quantity: 5,
    } as Parameters<typeof stockService.createMovement>[2]);
    expect(await level()).toBe(95); // 100 − 5 sold

    await service.submitForReview(company.id, count.id);
    await service.completeCount(company.id, user.id, count.id);

    // 95 − 5 (the discrepancy) = 90. NOT 95.
    expect(await level()).toBe(90);
  });

  it("adjusts stock value at the current average", async () => {
    const { company, user, product, countTo } = await countSetup(100);
    const count = await countTo(90);
    await service.submitForReview(company.id, count.id);
    await service.completeCount(company.id, user.id, count.id);

    const p = await prisma.product.findUnique({
      where: { id: product.id },
      select: { stockValue: true, avgCost: true },
    });
    expect(Number(p!.avgCost)).toBe(10); // unchanged by an adjustment
    expect(Number(p!.stockValue)).toBe(900); // 1000 − (10 × 10)
  });
});

describe("stock counting — workflow gates", () => {
  beforeEach(resetDb);

  it("can't record figures before starting", async () => {
    const { company, user, location } = await countSetup(100);
    const count = await service.createCount(company.id, user.id, {
      locationId: location.id,
    } as Parameters<typeof service.createCount>[2]);

    await expectAppError(
      service.recordCount(company.id, count.id, {
        itemId: count.items[0]!.id,
        countedQuantity: 95,
      } as Parameters<typeof service.recordCount>[2]),
      409
    );
  });

  it("can't submit for review with lines still uncounted", async () => {
    const { company, user, location } = await countSetup(100);
    await prisma.product.create({
      data: {
        companyId: company.id,
        sku: "SECOND",
        name: "Second Item",
        costPrice: 1,
        sellingPrice: 2,
      },
    });
    // Give the second product stock so it lands on the sheet.
    const second = await prisma.product.findFirst({
      where: { sku: "SECOND" },
    });
    await stockService.createMovement(company.id, user.id, {
      productId: second!.id,
      locationId: location.id,
      type: "PURCHASE",
      quantity: 5,
      unitCost: 1,
    } as Parameters<typeof stockService.createMovement>[2]);

    const count = await service.createCount(company.id, user.id, {
      locationId: location.id,
    } as Parameters<typeof service.createCount>[2]);
    await service.startCounting(company.id, count.id);
    await service.recordCount(company.id, count.id, {
      itemId: count.items[0]!.id,
      countedQuantity: 100,
    } as Parameters<typeof service.recordCount>[2]);

    const err = await expectAppError(
      service.submitForReview(company.id, count.id),
      400
    );
    expect(err.message).toContain("still to count");
  });

  it("can't complete without review — the gate PRD §12 asks for", async () => {
    const { company, user, countTo } = await countSetup(100);
    const count = await countTo(95);

    await expectAppError(
      service.completeCount(company.id, user.id, count.id),
      409
    );
  });

  it("counting zero is allowed and meaningful", async () => {
    // An empty shelf is a real finding.
    const { company, user, level, countTo } = await countSetup(100);
    const count = await countTo(0);
    await service.submitForReview(company.id, count.id);
    await service.completeCount(company.id, user.id, count.id);

    expect(await level()).toBe(0);
  });

  it("records who started and who completed", async () => {
    const { company, user, countTo } = await countSetup(100);
    const count = await countTo(95);
    await service.submitForReview(company.id, count.id);
    const done = await service.completeCount(company.id, user.id, count.id);

    expect(done.startedBy.id).toBe(user.id);
    expect(done.completedBy?.id).toBe(user.id);
    expect(done.completedAt).not.toBeNull();
  });

  it("can cancel before completing, but not after", async () => {
    const { company, user, countTo } = await countSetup(100);
    const abandoned = await countTo(95);
    const cancelled = await service.cancelCount(company.id, abandoned.id);
    expect(cancelled.status).toBe("CANCELLED");

    const second = await countTo(95);
    await service.submitForReview(company.id, second.id);
    await service.completeCount(company.id, user.id, second.id);
    const err = await expectAppError(
      service.cancelCount(company.id, second.id),
      409
    );
    expect(err.message).toContain("new adjustment");
  });

  it("a cancelled count touches nothing", async () => {
    const { company, level, countTo } = await countSetup(100);
    const count = await countTo(40);
    await service.cancelCount(company.id, count.id);

    expect(await level()).toBe(100);
    expect(
      await prisma.stockMovement.count({
        where: { companyId: company.id, type: "ADJUSTMENT" },
      })
    ).toBe(0);
  });

  it("numbers counts per company from 1", async () => {
    const { countTo } = await countSetup(100);
    const count = await countTo(95);
    expect(count.number).toBe(1);
    expect(service.cntRef(count.number)).toBe("CNT-0001");
  });
});

describe("stock counting — tenant isolation", () => {
  beforeEach(resetDb);

  it("A cannot read or complete B's count", async () => {
    const a = await createTestCompany("Alpha");
    const b = await countSetup(100);
    const count = await b.countTo(95);
    await service.submitForReview(b.company.id, count.id);

    await expectAppError(service.getCount(a.company.id, count.id), 404);
    await expectAppError(
      service.completeCount(a.company.id, a.user.id, count.id),
      404
    );
  });

  it("A cannot count at B's location", async () => {
    const a = await createTestCompany("Alpha");
    const b = await createTestCompany("Beta");
    await expectAppError(
      service.createCount(a.company.id, a.user.id, {
        locationId: b.location.id,
      } as Parameters<typeof service.createCount>[2]),
      404
    );
  });
});
