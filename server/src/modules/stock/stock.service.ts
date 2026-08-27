/**
 * Stock service — the diary keeper. The most important file in the app.
 *
 * Rules it enforces:
 * 1. Signs are decided HERE, never by the client
 * 2. Stock can never go below zero
 * 3. Transfers are two lines born together (transaction)
 * 4. Diary lines are only ever ADDED — no update, no delete, anywhere
 */
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import { notifyLowStock } from "../../lib/notify.js";
import { lockStock, lockCost, LOCKED_TX_OPTIONS } from "../../lib/locks.js";
import {
  costStockIn,
  costStockOut,
  costAdjustment,
} from "../../lib/costing.js";
import { Prisma } from "@prisma/client";
import {
  Dec,
  parseQuantity,
  formatQuantity,
  type Decimal,
} from "../../lib/quantity.js";
import {
  planAllocation,
  consumeAllocation,
  receiveIntoBatch,
} from "./batch.service.js";
import type {
  CreateMovementInput,
  TransferInput,
  ListMovementsQuery,
  LevelsQuery,
} from "./stock.schemas.js";

// Which way does each type move the stock?
const DIRECTION: Record<CreateMovementInput["type"], 1 | -1> = {
  PURCHASE: 1,
  RETURN_IN: 1,
  SALE: -1,
  RETURN_OUT: -1,
  ADJUSTMENT: 1, // adjustment quantity arrives already signed
};

/**
 * "How many are there right now?" = sum of all diary lines.
 *
 * Returns a Decimal since P1-2. Callers that want a plain number for display
 * should go through formatQuantity() rather than Number(), so fractional
 * stock never silently loses precision on the way to a screen.
 */
export async function getStockLevel(
  companyId: string,
  productId: string,
  locationId: string
): Promise<Decimal> {
  const result = await prisma.stockMovement.aggregate({
    where: { companyId, productId, locationId },
    _sum: { quantity: true },
  });
  return result._sum.quantity ?? new Dec(0);
}

/** Check the product and location really belong to this company. */
async function assertOwnership(
  companyId: string,
  productId: string,
  locationId: string
) {
  const [product, location] = await Promise.all([
    prisma.product.findFirst({ where: { id: productId, companyId } }),
    prisma.location.findFirst({ where: { id: locationId, companyId } }),
  ]);
  if (!product) throw new AppError(404, "Product not found");
  if (!product.isActive)
    throw new AppError(400, "This product is retired — reactivate it first");
  if (!location) throw new AppError(404, "Location not found");
  return { product, location };
}

export async function createMovement(
  companyId: string,
  userId: string,
  input: CreateMovementInput
) {
  const { product } = await assertOwnership(
    companyId,
    input.productId,
    input.locationId
  );

  // Parse and precision-check against THIS product (P1-2). ADJUSTMENT is the
  // one type allowed to arrive already negative ("found 2 broken" = -2).
  const requested = parseQuantity(input.quantity, product, {
    allowNegative: input.type === "ADJUSTMENT",
  });
  const signedQuantity = requested.times(DIRECTION[input.type]);
  const isOutgoing = signedQuantity.isNegative();

  // Batch-tracked products need a lot number on the way IN — without one the
  // stock has no identity and FEFO has nothing to sort. Checked before the
  // transaction so a bad request never opens one.
  if (product.tracksBatch && !isOutgoing && !input.batchNumber) {
    throw new AppError(
      400,
      `${product.name} is batch-tracked — a batch number is required for incoming stock`
    );
  }

  // The no-negative-stock rule.
  //
  // A transaction alone does NOT make this safe — see lib/locks.ts. The
  // advisory lock is what stops two simultaneous sales from both reading the
  // same "available" figure and both passing the check. Take it BEFORE the
  // read, or it protects nothing.
  const movement = await prisma.$transaction(async (tx) => {
    // Stock lock first, then the cost lock — always this order, everywhere,
    // so two transactions can never queue for them in opposite directions.
    await lockStock(tx, companyId, [
      { productId: input.productId, locationId: input.locationId },
    ]);
    await lockCost(tx, companyId, [input.productId]);

    if (isOutgoing) {
      const sum = await tx.stockMovement.aggregate({
        where: {
          companyId,
          productId: input.productId,
          locationId: input.locationId,
        },
        _sum: { quantity: true },
      });
      const current = sum._sum.quantity ?? new Dec(0);
      if (current.plus(signedQuantity).isNegative()) {
        throw new AppError(
          400,
          `Not enough stock: only ${formatQuantity(current)} ${product.unit} available at this location`
        );
      }
    }

    // Decide the batch split BEFORE writing the movement, so an impossible
    // allocation aborts the transaction before anything is recorded.
    const outgoingPlan =
      product.tracksBatch && isOutgoing
        ? await planAllocation(
            tx,
            companyId,
            input.productId,
            input.locationId,
            signedQuantity.abs(),
            product.batchStrategy
          )
        : null;

    // Update the weighted average and get the cost to stamp on this row.
    //
    // Transfers are absent from this switch on purpose: they never reach
    // createMovement (they have their own door), and moving your own stock
    // between your own shelves must not change what it cost you.
    let costAtTime: Prisma.Decimal | null = null;
    switch (input.type) {
      case "PURCHASE":
        // A purchase without a stated price falls back to the running
        // average — better than pretending the goods were free.
        costAtTime = await costStockIn(
          tx,
          companyId,
          input.productId,
          signedQuantity,
          input.unitCost !== undefined
            ? new Prisma.Decimal(input.unitCost)
            : product.avgCost
        );
        break;
      case "SALE":
      case "RETURN_OUT":
        costAtTime = await costStockOut(
          tx,
          companyId,
          input.productId,
          signedQuantity.abs()
        );
        break;
      case "RETURN_IN":
        // A bare return has no invoice to trace back to, so today's average
        // is the best available estimate. cancelInvoice() does better — it
        // restores the exact cost the units left at.
        costAtTime = await costAdjustment(
          tx,
          companyId,
          input.productId,
          signedQuantity
        );
        break;
      case "ADJUSTMENT":
        costAtTime = await costAdjustment(
          tx,
          companyId,
          input.productId,
          signedQuantity
        );
        break;
    }

    const created = await tx.stockMovement.create({
      data: {
        companyId,
        productId: input.productId,
        locationId: input.locationId,
        type: input.type,
        quantity: signedQuantity,
        unitCost: input.unitCost,
        costAtTime,
        reference: input.reference,
        note: input.note,
        batchNumber: input.batchNumber,
        expiryDate: input.expiryDate ? new Date(input.expiryDate) : undefined,
        createdById: userId,
      },
      include: {
        product: { select: { id: true, sku: true, name: true } },
        location: { select: { id: true, name: true } },
      },
    });

    if (outgoingPlan) {
      await consumeAllocation(tx, created.id, outgoingPlan);
    } else if (product.tracksBatch && !isOutgoing) {
      await receiveIntoBatch(tx, {
        companyId,
        productId: input.productId,
        locationId: input.locationId,
        movementId: created.id,
        batchNumber: input.batchNumber!,
        quantity: signedQuantity,
        unitCost:
          input.unitCost !== undefined ? new Prisma.Decimal(input.unitCost) : null,
        expiryDate: input.expiryDate ? new Date(input.expiryDate) : null,
      });
    }

    return created;
  }, LOCKED_TX_OPTIONS);

  // After an outgoing movement, fire a low-stock alert if this pushed the
  // product at/below its threshold. Fire-and-forget — never blocks or breaks
  // the movement. Dormant unless notification keys are configured.
  if (isOutgoing) {
    void (async () => {
      try {
        const [sum, product] = await Promise.all([
          prisma.stockMovement.aggregate({
            where: {
              companyId,
              productId: input.productId,
              locationId: input.locationId,
            },
            _sum: { quantity: true },
          }),
          prisma.product.findUnique({
            where: { id: input.productId },
            select: { name: true, sku: true, lowStockThreshold: true },
          }),
        ]);
        const onHand = sum._sum.quantity ?? new Dec(0);
        if (
          product &&
          product.lowStockThreshold.greaterThan(0) &&
          onHand.lessThanOrEqualTo(product.lowStockThreshold)
        ) {
          await notifyLowStock({
            productName: product.name,
            sku: product.sku,
            onHand: formatQuantity(onHand),
            threshold: formatQuantity(product.lowStockThreshold),
            location: movement.location.name,
          });
        }
      } catch {
        /* alerts must never affect the stock operation */
      }
    })();
  }

  return movement;
}

/**
 * A transfer = two diary lines stapled together by one transferId:
 *   -5 at the source, +5 at the destination.
 * Both happen or neither does. The books always balance.
 */
export async function transfer(
  companyId: string,
  userId: string,
  input: TransferInput
) {
  const { product } = await assertOwnership(
    companyId,
    input.productId,
    input.fromLocationId
  );
  const toLocation = await prisma.location.findFirst({
    where: { id: input.toLocationId, companyId },
  });
  if (!toLocation) throw new AppError(404, "Destination location not found");

  // Precision-check against the product before anything else (P1-2).
  const moving = parseQuantity(input.quantity, product);

  const transferId = randomUUID(); // the staple

  return prisma.$transaction(async (tx) => {
    // Lock BOTH shelves. lockStock sorts them, so an A→B transfer and a
    // simultaneous B→A transfer acquire the two keys in the same order and
    // cannot deadlock against each other.
    await lockStock(tx, companyId, [
      { productId: input.productId, locationId: input.fromLocationId },
      { productId: input.productId, locationId: input.toLocationId },
    ]);

    const sum = await tx.stockMovement.aggregate({
      where: {
        companyId,
        productId: input.productId,
        locationId: input.fromLocationId,
      },
      _sum: { quantity: true },
    });
    const current = sum._sum.quantity ?? new Dec(0);
    if (current.lessThan(moving)) {
      throw new AppError(
        400,
        `Not enough stock to transfer: only ${formatQuantity(current)} ${product.unit} available at source`
      );
    }

    const common = {
      companyId,
      productId: input.productId,
      note: input.note,
      transferId,
      createdById: userId,
    };

    // For batch-tracked products, work out which lots are leaving BEFORE
    // writing anything — a transfer must carry batch identity across, not
    // launder it. Stock that expires in September must still expire in
    // September after it moves shelves.
    const plan = product.tracksBatch
      ? await planAllocation(
          tx,
          companyId,
          input.productId,
          input.fromLocationId,
          moving,
          product.batchStrategy
        )
      : null;

    const out = await tx.stockMovement.create({
      data: {
        ...common,
        locationId: input.fromLocationId,
        type: "TRANSFER_OUT",
        quantity: moving.negated(),
      },
    });
    const inn = await tx.stockMovement.create({
      data: {
        ...common,
        locationId: input.toLocationId,
        type: "TRANSFER_IN",
        quantity: moving,
      },
    });

    if (plan) {
      // Take the lots out of the source...
      await consumeAllocation(tx, out.id, plan);

      // ...and recreate each one at the destination, preserving its number,
      // expiry and cost. Same lot, new shelf.
      for (const slice of plan) {
        const source = await tx.inventoryBatch.findUnique({
          where: { id: slice.batchId },
        });
        if (!source) continue;
        await receiveIntoBatch(tx, {
          companyId,
          productId: input.productId,
          locationId: input.toLocationId,
          movementId: inn.id,
          batchNumber: source.batchNumber,
          quantity: slice.quantity,
          unitCost: source.unitCost,
          manufactureDate: source.manufactureDate,
          expiryDate: source.expiryDate,
        });
      }
    }

    return { transferId, out, in: inn };
  }, LOCKED_TX_OPTIONS);
}

/** The diary, newest first, with names attached and pagination. */
export async function listMovements(
  companyId: string,
  q: ListMovementsQuery
) {
  const where = {
    companyId,
    ...(q.productId ? { productId: q.productId } : {}),
    ...(q.locationId ? { locationId: q.locationId } : {}),
    ...(q.type ? { type: q.type } : {}),
    // Only build the createdAt filter if at least one bound is present.
    ...(q.from || q.to
      ? {
          createdAt: {
            ...(q.from ? { gte: new Date(q.from) } : {}),
            ...(q.to ? { lte: new Date(q.to) } : {}),
          },
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.stockMovement.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: q.take,
      skip: q.skip,
      include: {
        product: { select: { id: true, sku: true, name: true } },
        location: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
    }),
    prisma.stockMovement.count({ where }),
  ]);

  return { items, total, take: q.take, skip: q.skip };
}

/**
 * Current totals: every product × location combination that has
 * movements, with a lowStock flag the dashboard will love.
 */
export async function stockLevels(companyId: string, q: LevelsQuery) {
  const grouped = await prisma.stockMovement.groupBy({
    by: ["productId", "locationId"],
    where: {
      companyId,
      ...(q.locationId ? { locationId: q.locationId } : {}),
      ...(q.productId ? { productId: q.productId } : {}),
    },
    _sum: { quantity: true },
  });

  // groupBy gives ids only — fetch the names in two quick lookups
  const productIds = [...new Set(grouped.map((g) => g.productId))];
  const locationIds = [...new Set(grouped.map((g) => g.locationId))];

  const [products, locations] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: productIds }, companyId },
      select: {
        id: true,
        sku: true,
        name: true,
        unit: true,
        lowStockThreshold: true,
        isActive: true,
      },
    }),
    prisma.location.findMany({
      where: { id: { in: locationIds }, companyId },
      select: { id: true, name: true },
    }),
  ]);
  const productById = new Map(products.map((p) => [p.id, p]));
  const locationById = new Map(locations.map((l) => [l.id, l]));

  return grouped
    .map((g) => {
      const product = productById.get(g.productId);
      const location = locationById.get(g.locationId);
      const quantity = g._sum.quantity ?? new Dec(0);
      if (!product || !location) return null; // shouldn't happen; be safe
      return {
        product,
        location,
        quantity,
        // Retired products never count as low stock (no alerts/banner/badge).
        lowStock:
          product.isActive &&
          quantity.lessThanOrEqualTo(product.lowStockThreshold),
      };
    })
    .filter((row) => row !== null);
}
