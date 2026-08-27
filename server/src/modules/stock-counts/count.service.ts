/**
 * Stock counting (P1-9).
 *
 * THE RULE (PRD §12): "Never silently overwrite system stock."
 *
 * Completing a count does NOT set the ledger to whatever was on the clipboard.
 * It writes ADJUSTMENT movements for the variance, so a correction is an event
 * with a person and a time attached. A stocktake that quietly rewrote the
 * numbers would destroy the audit trail that makes the ledger worth having —
 * and "the computer says 47" with no explanation is exactly the situation
 * inventory systems exist to prevent.
 *
 *     OPEN → COUNTING → REVIEW → COMPLETED
 *       ↓                            ↑
 *   CANCELLED              adjustments written here
 *
 * WHY THE ADJUSTMENT IS A DELTA, NOT A SET
 *
 * This is the decision that matters most, and it only shows itself when stock
 * moves while people are counting.
 *
 * Count 95, expected 100, then a genuine sale of 5 happens before anyone gets
 * round to completing:
 *
 *   Set stock TO 95   → ledger says 95, shelf holds 90. The sale is erased.
 *   Apply variance −5 → ledger becomes 95 − 5 = 90. Correct.
 *
 * A count measures a DISCREPANCY at a point in time. Applying that discrepancy
 * as a delta preserves whatever legitimately happened since, which is why
 * `expectedQuantity` is snapshotted when the sheet is prepared rather than
 * re-read at the end.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import {
  lockStock,
  lockCost,
  lockCounter,
  lockDocument,
  LOCKED_TX_OPTIONS,
} from "../../lib/locks.js";
import { costAdjustment } from "../../lib/costing.js";
import { parseQuantity, Dec } from "../../lib/quantity.js";
import type {
  CreateCountInput,
  RecordCountInput,
  ListCountsQuery,
} from "./count.schemas.js";

export function cntRef(number: number): string {
  return `CNT-${String(number).padStart(4, "0")}`;
}

const countInclude = {
  location: { select: { id: true, name: true } },
  startedBy: { select: { id: true, name: true } },
  completedBy: { select: { id: true, name: true } },
  items: {
    include: {
      product: {
        select: { id: true, sku: true, name: true, unit: true, precision: true },
      },
      batch: { select: { id: true, batchNumber: true, expiryDate: true } },
    },
    orderBy: { product: { name: "asc" } },
  },
} as const;

/** Attach the derived variance — see the note in schema.prisma about not storing it. */
function withVariance<
  T extends {
    items: {
      expectedQuantity: Prisma.Decimal;
      countedQuantity: Prisma.Decimal | null;
    }[];
  },
>(count: T) {
  return {
    ...count,
    items: count.items.map((i) => ({
      ...i,
      variance: i.countedQuantity
        ? i.countedQuantity.minus(i.expectedQuantity)
        : null,
    })),
  };
}

/**
 * Prepare a count sheet, snapshotting what the system believes right now.
 *
 * With no productIds, every product that has stock at the location is
 * included. Products with no stock are skipped by default — a sheet listing
 * 2,000 products the shop has never carried is a sheet nobody will finish.
 */
export async function createCount(
  companyId: string,
  userId: string,
  input: CreateCountInput
) {
  return prisma.$transaction(async (tx) => {
    const location = await tx.location.findFirst({
      where: { id: input.locationId, companyId },
    });
    if (!location) throw new AppError(404, "Location not found");

    // What the system believes, per product, at this location.
    const grouped = await tx.stockMovement.groupBy({
      by: ["productId"],
      where: { companyId, locationId: input.locationId },
      _sum: { quantity: true },
    });

    let expectedByProduct = new Map(
      grouped.map((g) => [g.productId, g._sum.quantity ?? new Dec(0)])
    );

    if (input.productIds && input.productIds.length > 0) {
      // A targeted count — include the named products even at zero, because
      // "we think there are none, confirm that" is a legitimate thing to ask.
      const named = await tx.product.findMany({
        where: { id: { in: input.productIds }, companyId },
        select: { id: true },
      });
      if (named.length !== new Set(input.productIds).size) {
        throw new AppError(400, "One or more products don't exist");
      }
      expectedByProduct = new Map(
        named.map((p) => [p.id, expectedByProduct.get(p.id) ?? new Dec(0)])
      );
    } else if (!input.includeZeroStock) {
      for (const [productId, qty] of expectedByProduct) {
        if (qty.isZero()) expectedByProduct.delete(productId);
      }
    }

    if (expectedByProduct.size === 0) {
      throw new AppError(400, "There's nothing to count at this location");
    }

    await lockCounter(tx, companyId, "stock-count");
    const last = await tx.stockCount.findFirst({
      where: { companyId },
      orderBy: { number: "desc" },
      select: { number: true },
    });

    const created = await tx.stockCount.create({
      data: {
        companyId,
        number: (last?.number ?? 0) + 1,
        locationId: input.locationId,
        notes: input.notes,
        startedById: userId,
        items: {
          create: [...expectedByProduct.entries()].map(
            ([productId, expectedQuantity]) => ({
              productId,
              expectedQuantity,
            })
          ),
        },
      },
      include: countInclude,
    });
    return withVariance(created);
  }, LOCKED_TX_OPTIONS);
}

/** OPEN → COUNTING. The sheet is out on the floor. */
export async function startCounting(companyId: string, id: string) {
  const count = await prisma.stockCount.findFirst({
    where: { id, companyId },
    select: { id: true, status: true },
  });
  if (!count) throw new AppError(404, "Stock count not found");
  if (count.status !== "OPEN") {
    throw new AppError(409, "Only an open count can be started");
  }

  const updated = await prisma.stockCount.update({
    where: { id: count.id },
    data: { status: "COUNTING" },
    include: countInclude,
  });
  return withVariance(updated);
}

/**
 * Record what was physically found for one line.
 *
 * Zero is a legitimate count — "the shelf is empty" is information. That's why
 * `countedQuantity` is nullable: null means nobody has looked yet, which is a
 * different thing entirely.
 */
export async function recordCount(
  companyId: string,
  id: string,
  input: RecordCountInput
) {
  const count = await prisma.stockCount.findFirst({
    where: { id, companyId },
    select: { id: true, status: true },
  });
  if (!count) throw new AppError(404, "Stock count not found");
  if (count.status !== "COUNTING" && count.status !== "REVIEW") {
    throw new AppError(409, "Start the count before entering figures");
  }

  const item = await prisma.stockCountItem.findFirst({
    where: { id: input.itemId, stockCountId: count.id },
    include: {
      product: { select: { name: true, unit: true, precision: true } },
    },
  });
  if (!item) throw new AppError(404, "That line isn't on this count");

  // Zero is allowed here, unlike everywhere else quantities are parsed —
  // an empty shelf is a real finding.
  const counted =
    Number(input.countedQuantity) === 0
      ? new Dec(0)
      : parseQuantity(input.countedQuantity, item.product);

  await prisma.stockCountItem.update({
    where: { id: item.id },
    data: { countedQuantity: counted, notes: input.notes },
  });

  return getCount(companyId, count.id);
}

/** COUNTING → REVIEW. Everything has a figure; a human should look at it. */
export async function submitForReview(companyId: string, id: string) {
  const count = await prisma.stockCount.findFirst({
    where: { id, companyId },
    include: { items: { select: { countedQuantity: true } } },
  });
  if (!count) throw new AppError(404, "Stock count not found");
  if (count.status !== "COUNTING") {
    throw new AppError(409, "Only a count in progress can be submitted");
  }

  const uncounted = count.items.filter((i) => i.countedQuantity === null).length;
  if (uncounted > 0) {
    throw new AppError(
      400,
      `${uncounted} item${uncounted === 1 ? "" : "s"} still to count`
    );
  }

  const updated = await prisma.stockCount.update({
    where: { id: count.id },
    data: { status: "REVIEW" },
    include: countInclude,
  });
  return withVariance(updated);
}

/**
 * REVIEW → COMPLETED. Writes the adjustments.
 *
 * One ADJUSTMENT movement per non-zero variance, signed. Lines that matched
 * produce nothing — there's no event to record when reality agreed with the
 * system, and writing zero-quantity movements would bury the real corrections.
 */
export async function completeCount(
  companyId: string,
  userId: string,
  id: string
) {
  return prisma.$transaction(async (tx) => {
    await lockDocument(tx, "stock-count", id);

    const count = await tx.stockCount.findFirst({
      where: { id, companyId },
      include: { items: true },
    });
    if (!count) throw new AppError(404, "Stock count not found");
    if (count.status !== "REVIEW") {
      throw new AppError(
        409,
        "A count must be reviewed before its adjustments are applied"
      );
    }

    // Only lines that actually differ produce a movement.
    const discrepancies = count.items
      .filter((i) => i.countedQuantity !== null)
      .map((i) => ({
        item: i,
        variance: i.countedQuantity!.minus(i.expectedQuantity),
      }))
      .filter((d) => !d.variance.isZero());

    if (discrepancies.length > 0) {
      // Stock locks first, then cost locks — the ordering rule from P1-3.
      await lockStock(
        tx,
        companyId,
        discrepancies.map((d) => ({
          productId: d.item.productId,
          locationId: count.locationId,
        }))
      );
      await lockCost(
        tx,
        companyId,
        discrepancies.map((d) => d.item.productId)
      );
    }

    const ref = cntRef(count.number);

    for (const { item, variance } of discrepancies) {
      // Found stock is valued at today's average; lost stock removes value at
      // the same rate. We have no better information about what those specific
      // units cost.
      const costAtTime = await costAdjustment(
        tx,
        companyId,
        item.productId,
        variance
      );

      await tx.stockMovement.create({
        data: {
          companyId,
          productId: item.productId,
          locationId: count.locationId,
          type: "ADJUSTMENT",
          // SIGNED delta, not the counted figure — see the header note.
          quantity: variance,
          costAtTime,
          reference: ref,
          note: `Stock count ${ref}: expected ${item.expectedQuantity.toString()}, counted ${item.countedQuantity!.toString()}`,
          createdById: userId,
        },
      });
    }

    const updated = await tx.stockCount.update({
      where: { id: count.id },
      data: {
        status: "COMPLETED",
        completedById: userId,
        completedAt: new Date(),
      },
      include: countInclude,
    });
    return withVariance(updated);
  }, LOCKED_TX_OPTIONS);
}

/** Abandon a count. Nothing has touched the ledger, so nothing to undo. */
export async function cancelCount(companyId: string, id: string) {
  const count = await prisma.stockCount.findFirst({
    where: { id, companyId },
    select: { id: true, status: true },
  });
  if (!count) throw new AppError(404, "Stock count not found");
  if (count.status === "COMPLETED") {
    throw new AppError(
      409,
      "This count's adjustments are already in the ledger — correct them with a new adjustment"
    );
  }
  if (count.status === "CANCELLED") {
    throw new AppError(409, "This count is already cancelled");
  }

  const updated = await prisma.stockCount.update({
    where: { id: count.id },
    data: { status: "CANCELLED" },
    include: countInclude,
  });
  return withVariance(updated);
}

export async function listCounts(companyId: string, q: ListCountsQuery) {
  const where = {
    companyId,
    ...(q.status ? { status: q.status } : {}),
    ...(q.locationId ? { locationId: q.locationId } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.stockCount.findMany({
      where,
      orderBy: { number: "desc" },
      take: q.take,
      skip: q.skip,
      include: countInclude,
    }),
    prisma.stockCount.count({ where }),
  ]);

  return { items: items.map(withVariance), total, take: q.take, skip: q.skip };
}

export async function getCount(companyId: string, id: string) {
  const count = await prisma.stockCount.findFirst({
    where: { id, companyId },
    include: countInclude,
  });
  if (!count) throw new AppError(404, "Stock count not found");
  return withVariance(count);
}
