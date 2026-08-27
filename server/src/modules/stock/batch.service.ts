/**
 * Batch inventory — which physical lot the stock came from.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The ledger can tell you "there are 200 units here". For anything perishable
 * that isn't enough: 100 expire in September and 100 in December, and if you
 * ship the December ones first the September ones rot on the shelf. The
 * ledger has no opinion about which units leave, because to it a unit is a
 * unit.
 *
 * `InventoryBatch` gives units an identity, and this file decides which ones
 * go out the door.
 *
 * FEFO — First Expired, First Out — is the default for expiry-tracked goods:
 * always ship the stock closest to expiring. FIFO — oldest received first —
 * is for goods that don't expire. This is a per-product setting
 * (`Product.batchStrategy`).
 *
 * CONCURRENCY (how this sits on top of P0)
 *
 * Allocation reads `remainingQuantity`, decides a split, and writes it back.
 * That is exactly the read-then-write shape that made the oversell bug
 * possible, so every function here MUST be called inside a transaction that
 * already holds `lockStock(companyId, [{productId, locationId}])`.
 *
 * We get that for free: the lock key is (company, product, location), which is
 * a batch's identity minus its number. Two concurrent sales of the same
 * product at the same location already queue behind each other, so they also
 * queue through allocation. No second lock is needed — but the ordering is
 * load-bearing, so callers must not "optimise" it away.
 *
 * DECIMALS
 *
 * Quantities here are Prisma `Decimal`, not JS numbers, because 0.1 + 0.2 is
 * famously not 0.3 in binary floating point and inventory that drifts is
 * worse than useless. Arithmetic goes through Decimal methods throughout.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import type { Tx } from "../../lib/locks.js";

const D = Prisma.Decimal;
export type Decimal = Prisma.Decimal;

/** One slice of an allocation: take `quantity` from `batchId`. */
export type Allocation = {
  batchId: string;
  batchNumber: string;
  quantity: Decimal; // always POSITIVE here; the caller applies the sign
};

/**
 * Order batches for consumption.
 *
 * FEFO: nearest expiry first — but batches with NO expiry must sort LAST, not
 * first. A null expiry means "never expires", and shipping never-expiring
 * stock ahead of stock that expires next week is precisely backwards. SQL's
 * default ordering puts NULLs first for ASC, which is why this is explicit.
 *
 * Ties (same expiry, or FIFO mode) fall back to oldest-received.
 */
function orderFor(strategy: "FEFO" | "FIFO"): Prisma.InventoryBatchOrderByWithRelationInput[] {
  if (strategy === "FIFO") {
    return [{ createdAt: "asc" }, { batchNumber: "asc" }];
  }
  return [
    { expiryDate: { sort: "asc", nulls: "last" } },
    { createdAt: "asc" },
    { batchNumber: "asc" },
  ];
}

/**
 * Work out which batches to draw `quantity` from, without writing anything.
 *
 * Throws if the batches don't hold enough. That check is the batch-level twin
 * of the ledger's oversell guard: both must agree, and if they ever disagree
 * that means batch data has drifted from the ledger and we'd rather fail loudly
 * than quietly ship stock we can't account for.
 */
export async function planAllocation(
  tx: Tx,
  companyId: string,
  productId: string,
  locationId: string,
  quantity: Decimal,
  strategy: "FEFO" | "FIFO"
): Promise<Allocation[]> {
  if (quantity.lessThanOrEqualTo(0)) {
    throw new AppError(400, "Quantity to allocate must be positive");
  }

  const batches = await tx.inventoryBatch.findMany({
    where: {
      companyId,
      productId,
      locationId,
      remainingQuantity: { gt: 0 },
    },
    orderBy: orderFor(strategy),
  });

  const plan: Allocation[] = [];
  let outstanding = quantity;

  for (const batch of batches) {
    if (outstanding.lessThanOrEqualTo(0)) break;

    // Take the smaller of "what's left to fill" and "what this batch holds".
    const take = outstanding.lessThan(batch.remainingQuantity)
      ? outstanding
      : batch.remainingQuantity;

    plan.push({
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      quantity: take,
    });
    outstanding = outstanding.minus(take);
  }

  if (outstanding.greaterThan(0)) {
    const available = quantity.minus(outstanding);
    throw new AppError(
      400,
      `Not enough batch stock: only ${available.toString()} available across batches at this location`
    );
  }

  return plan;
}

/**
 * Apply an allocation: decrement each batch and record the split against the
 * movement.
 *
 * The decrement is a conditional UPDATE (`remainingQuantity >= take`) rather
 * than a plain write. Inside the advisory lock that condition can't fail — but
 * if a future caller ever forgets the lock, this turns silent corruption into a
 * loud error, and the `remainingQuantity >= 0` CHECK constraint sits behind it
 * as the last line. Three layers, because the ledger being wrong is the one
 * failure this system cannot recover from.
 */
export async function consumeAllocation(
  tx: Tx,
  movementId: string,
  plan: Allocation[]
): Promise<void> {
  for (const slice of plan) {
    const updated = await tx.inventoryBatch.updateMany({
      where: {
        id: slice.batchId,
        remainingQuantity: { gte: slice.quantity },
      },
      data: { remainingQuantity: { decrement: slice.quantity } },
    });

    if (updated.count !== 1) {
      // Only reachable if the lock was skipped or batch data drifted.
      throw new AppError(
        409,
        `Batch ${slice.batchNumber} changed while allocating — please retry`
      );
    }

    await tx.stockMovementBatch.create({
      data: {
        movementId,
        batchId: slice.batchId,
        quantity: slice.quantity.negated(), // consumed → negative
      },
    });
  }
}

/**
 * Add incoming stock to a batch, creating the lot if it's new.
 *
 * Re-receiving the same batch number at the same location is normal — a second
 * delivery from the same production lot — so this upserts: top up the existing
 * lot rather than rejecting it or creating a confusing duplicate.
 */
export async function receiveIntoBatch(
  tx: Tx,
  params: {
    companyId: string;
    productId: string;
    locationId: string;
    movementId: string;
    batchNumber: string;
    quantity: Decimal;
    unitCost?: Decimal | null;
    manufactureDate?: Date | null;
    expiryDate?: Date | null;
  }
): Promise<string> {
  const {
    companyId,
    productId,
    locationId,
    movementId,
    batchNumber,
    quantity,
    unitCost,
    manufactureDate,
    expiryDate,
  } = params;

  if (quantity.lessThanOrEqualTo(0)) {
    throw new AppError(400, "Received quantity must be positive");
  }

  const existing = await tx.inventoryBatch.findFirst({
    where: { companyId, productId, locationId, batchNumber },
  });

  let batchId: string;

  if (existing) {
    await tx.inventoryBatch.update({
      where: { id: existing.id },
      data: {
        receivedQuantity: { increment: quantity },
        remainingQuantity: { increment: quantity },
        // Late-arriving detail is worth keeping, but never blank out what we
        // already know: only fill gaps.
        expiryDate: existing.expiryDate ?? expiryDate ?? undefined,
        manufactureDate: existing.manufactureDate ?? manufactureDate ?? undefined,
        ...(unitCost ? { unitCost } : {}),
      },
    });
    batchId = existing.id;
  } else {
    const created = await tx.inventoryBatch.create({
      data: {
        companyId,
        productId,
        locationId,
        batchNumber,
        manufactureDate: manufactureDate ?? null,
        expiryDate: expiryDate ?? null,
        unitCost: unitCost ?? new D(0),
        receivedQuantity: quantity,
        remainingQuantity: quantity,
      },
    });
    batchId = created.id;
  }

  await tx.stockMovementBatch.create({
    data: { movementId, batchId, quantity }, // incoming → positive
  });

  return batchId;
}

/**
 * Return stock to specific batches — the exact reverse of a consumption.
 *
 * Used when an issued invoice is cancelled: the units go back to the very lots
 * they left, so a cancellation can't quietly launder September stock into
 * December stock. Reads the original movement's allocations and reverses them.
 */
export async function restoreAllocationsOf(
  tx: Tx,
  originalMovementId: string,
  newMovementId: string
): Promise<boolean> {
  const original = await tx.stockMovementBatch.findMany({
    where: { movementId: originalMovementId },
  });
  if (original.length === 0) return false;

  for (const slice of original) {
    const back = slice.quantity.abs();
    await tx.inventoryBatch.update({
      where: { id: slice.batchId },
      data: { remainingQuantity: { increment: back } },
    });
    await tx.stockMovementBatch.create({
      data: { movementId: newMovementId, batchId: slice.batchId, quantity: back },
    });
  }
  return true;
}

/** Live batch list for a product at a location — powers the Batches UI. */
export async function listBatches(
  companyId: string,
  filters: {
    productId?: string;
    locationId?: string;
    includeEmpty?: boolean;
    expiringBefore?: Date;
  }
) {
  return prisma.inventoryBatch.findMany({
    where: {
      companyId,
      ...(filters.productId ? { productId: filters.productId } : {}),
      ...(filters.locationId ? { locationId: filters.locationId } : {}),
      ...(filters.includeEmpty ? {} : { remainingQuantity: { gt: 0 } }),
      // "What's about to go off?" — the expiring-stock report.
      ...(filters.expiringBefore
        ? { expiryDate: { not: null, lte: filters.expiringBefore } }
        : {}),
    },
    orderBy: [
      { expiryDate: { sort: "asc", nulls: "last" } },
      { createdAt: "asc" },
    ],
    include: {
      product: { select: { id: true, sku: true, name: true, unit: true } },
      location: { select: { id: true, name: true } },
    },
  });
}
