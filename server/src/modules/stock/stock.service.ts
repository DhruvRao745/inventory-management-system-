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
import { availableQuantity } from "../../lib/reservations.js";
import { recordAudit } from "../../lib/audit.js";
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

  /**
   * Which condition bucket this movement lands in (P2-2).
   *
   * ADJUSTMENT is the one type that may name a non-AVAILABLE status while
   * going OUT, and that freedom is load-bearing: reclassifying stock is a
   * PAIR of adjustments — −5 QUARANTINE and +5 AVAILABLE — so the negative
   * half must be allowed to say which bucket it is draining. Forbidding it
   * would make quarantine a one-way door with no way to release goods.
   *
   * A SALE or RETURN_OUT, by contrast, is forced to AVAILABLE. Those consume
   * sellable stock by definition — that is what the guard below measured — and
   * letting a client tag a sale DAMAGED would drain a bucket nothing was ever
   * put into, driving it negative while sellable stock stayed untouched.
   */
  const movementStatus: "AVAILABLE" | "DAMAGED" | "QUARANTINE" | "EXPIRED" =
    input.type === "ADJUSTMENT" || !isOutgoing
      ? (input.status ?? "AVAILABLE")
      : "AVAILABLE";

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
      if (movementStatus === "AVAILABLE") {
        // The normal case. Since P2-1 the test is against AVAILABLE, not on
        // hand: stock that is reserved is physically present but already
        // promised, so selling it would make the same promise twice. Since
        // P2-2 "available" also excludes damaged and quarantined goods. The
        // lock taken above covers reservations too — same key — so this read
        // cannot be overtaken by a reservation committing alongside it.
        const { onHand, reserved, available } = await availableQuantity(
          tx,
          companyId,
          { productId: input.productId, locationId: input.locationId }
        );

        if (available.plus(signedQuantity).isNegative()) {
          // Name the reservation explicitly. "Only 2 available" when the shelf
          // visibly holds 10 is the kind of message that gets a system called
          // broken; "8 of 10 are reserved" is a fact someone can act on.
          const detail = reserved.greaterThan(0)
            ? `only ${formatQuantity(available)} ${product.unit} available ` +
              `(${formatQuantity(onHand)} on hand, ${formatQuantity(reserved)} reserved)`
            : `only ${formatQuantity(onHand)} ${product.unit} available at this location`;
          throw new AppError(400, `Not enough stock: ${detail}`);
        }
      } else {
        // Taking stock OUT of a non-sellable bucket — writing off damage, or
        // the negative half of a reclassification. It must be checked against
        // THAT bucket, not against sellable stock: you cannot release 5 units
        // from quarantine when only 2 are quarantined, no matter how much good
        // stock sits beside it. Reservations are irrelevant here, because only
        // sellable stock can ever be reserved.
        const bucket = await tx.stockMovement.aggregate({
          where: {
            companyId,
            productId: input.productId,
            locationId: input.locationId,
            status: movementStatus,
          },
          _sum: { quantity: true },
        });
        const held = bucket._sum.quantity ?? new Dec(0);
        if (held.plus(signedQuantity).isNegative()) {
          throw new AppError(
            400,
            `Not enough ${movementStatus.toLowerCase()} stock: only ${formatQuantity(held)} ${product.unit} at this location`
          );
        }
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
        status: movementStatus, // see the note where this is computed
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
        // The lot inherits the movement's condition, so a quarantined delivery
        // creates a quarantined lot that FEFO will not touch.
        status: movementStatus,
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
        // Measure the SAME thing the stock list and nav badge measure:
        // available, not on hand (P2-1/P2-2). Alerting on on-hand while the
        // screen judges on available is worse than either rule alone — the
        // badge would light up with no email, or an email would arrive about a
        // shelf the UI calls healthy, and nobody would trust either.
        const [{ available }, product] = await Promise.all([
          availableQuantity(prisma, companyId, {
            productId: input.productId,
            locationId: input.locationId,
          }),
          prisma.product.findUnique({
            where: { id: input.productId },
            select: { name: true, sku: true, lowStockThreshold: true },
          }),
        ]);
        if (
          product &&
          product.lowStockThreshold.greaterThan(0) &&
          available.lessThanOrEqualTo(product.lowStockThreshold)
        ) {
          await notifyLowStock({
            productName: product.name,
            sku: product.sku,
            onHand: formatQuantity(available),
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

    // Availability, not on hand (P2-1). Moving reserved goods to another shelf
    // would quietly break the promise they're being held for: the reservation
    // names a product AND a location, so stock that walks away from that
    // location stops backing the hold even though nothing was sold.
    const { onHand, reserved, available } = await availableQuantity(
      tx,
      companyId,
      { productId: input.productId, locationId: input.fromLocationId }
    );
    if (available.lessThan(moving)) {
      const detail = reserved.greaterThan(0)
        ? `only ${formatQuantity(available)} ${product.unit} available at source ` +
          `(${formatQuantity(onHand)} on hand, ${formatQuantity(reserved)} reserved)`
        : `only ${formatQuantity(onHand)} ${product.unit} available at source`;
      throw new AppError(400, `Not enough stock to transfer: ${detail}`);
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
  // Grouped by STATUS too since P2-2, so one query yields both "what we own"
  // and "what we may sell" rather than two passes over the ledger.
  const grouped = await prisma.stockMovement.groupBy({
    by: ["productId", "locationId", "status"],
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

  // Reserved per shelf, in ONE grouped query rather than one per row (P2-1).
  // A per-row lookup here would be an N+1 across the whole catalogue — the
  // sort of thing that is invisible on ten products and fatal on ten thousand.
  const now = new Date();
  const reservedGroups = await prisma.stockReservation.groupBy({
    by: ["productId", "locationId"],
    where: {
      companyId,
      status: "ACTIVE",
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      ...(q.locationId ? { locationId: q.locationId } : {}),
      ...(q.productId ? { productId: q.productId } : {}),
    },
    _sum: { quantity: true },
  });
  const reservedByShelf = new Map<string, Decimal>(
    reservedGroups.map((r): [string, Decimal] => [
      `${r.productId}:${r.locationId}`,
      r._sum.quantity ?? new Dec(0),
    ])
  );

  // Fold the status rows back into ONE row per shelf. The ledger is grouped by
  // status, but a stock list is read per shelf — a product appearing four
  // times because four conditions exist would be unreadable.
  type Shelf = {
    productId: string;
    locationId: string;
    onHand: Decimal;
    byStatus: Record<string, Decimal>;
  };
  const shelves = new Map<string, Shelf>();
  for (const g of grouped) {
    const key = `${g.productId}:${g.locationId}`;
    const qty = g._sum.quantity ?? new Dec(0);
    const shelf: Shelf = shelves.get(key) ?? {
      productId: g.productId,
      locationId: g.locationId,
      onHand: new Dec(0),
      byStatus: {},
    };
    shelf.onHand = shelf.onHand.plus(qty);
    shelf.byStatus[g.status] = (shelf.byStatus[g.status] ?? new Dec(0)).plus(qty);
    shelves.set(key, shelf);
  }

  return [...shelves.values()]
    .map((g) => {
      const product = productById.get(g.productId);
      const location = locationById.get(g.locationId);
      if (!product || !location) return null; // shouldn't happen; be safe

      // `quantity` still means ON HAND — everything owned here, in any
      // condition. Renaming it would silently change the meaning of a field
      // every existing caller already reads.
      const quantity = g.onHand;
      const sellable = g.byStatus.AVAILABLE ?? new Dec(0);
      const damaged = g.byStatus.DAMAGED ?? new Dec(0);
      const quarantine = g.byStatus.QUARANTINE ?? new Dec(0);
      const expired = g.byStatus.EXPIRED ?? new Dec(0);

      const reserved =
        reservedByShelf.get(`${g.productId}:${g.locationId}`) ?? new Dec(0);
      // Available is built on SELLABLE, not on hand: damaged goods can't fill
      // an order any more than reserved ones can.
      const available = sellable.minus(reserved);

      return {
        product,
        location,
        quantity, // ON HAND — everything owned here, any condition
        sellable, // good stock only
        damaged,
        quarantine,
        expired,
        reserved,
        available, // sellable − reserved: what a new order can actually take
        // Low stock is judged on AVAILABLE. Goods that are promised, damaged
        // or quarantined can't fill the next order, so a shelf that looks full
        // but is entirely spoken-for or broken genuinely does need reordering.
        lowStock:
          product.isActive &&
          available.lessThanOrEqualTo(product.lowStockThreshold),
      };
    })
    .filter((row) => row !== null);
}

/**
 * Move stock from one condition to another (P2-2).
 *
 *   quarantine cleared  → QUARANTINE  → AVAILABLE
 *   goods found broken  → AVAILABLE   → DAMAGED
 *   written off at date → AVAILABLE   → EXPIRED
 *
 * WHY THIS IS TWO MOVEMENTS AND NOT AN UPDATE
 *
 * The obvious implementation is to change `status` on the original rows. It is
 * also wrong, and wrong in a way that is hard to see until you need the
 * history. Movements are immutable — that is the P0 rule the whole ledger
 * rests on. Rewriting one would mean the record of "these 5 units sat in
 * quarantine from Tuesday to Friday" simply stops existing: after the update
 * the ledger claims they were always available, and nobody can tell that an
 * inspection ever happened.
 *
 * So a reclassification is an EVENT, like every other change to stock: one
 * negative ADJUSTMENT draining the old bucket, one positive filling the new,
 * both stamped with a person and a time, written together in one transaction.
 * Total on hand doesn't move — nothing physically happened, the goods were
 * only re-labelled.
 */
export async function reclassifyStock(
  companyId: string,
  userId: string,
  input: {
    productId: string;
    locationId: string;
    quantity: number | string;
    fromStatus: "AVAILABLE" | "DAMAGED" | "QUARANTINE" | "EXPIRED";
    toStatus: "AVAILABLE" | "DAMAGED" | "QUARANTINE" | "EXPIRED";
    note?: string;
  }
) {
  if (input.fromStatus === input.toStatus) {
    throw new AppError(400, "Nothing to do — the statuses are the same");
  }

  const { product } = await assertOwnership(
    companyId,
    input.productId,
    input.locationId
  );
  const moving = parseQuantity(input.quantity, product);

  return prisma.$transaction(async (tx) => {
    await lockStock(tx, companyId, [
      { productId: input.productId, locationId: input.locationId },
    ]);

    // Enough in the SOURCE bucket? Checked against that bucket alone — you
    // can't release 5 from quarantine when only 2 are quarantined, however
    // much good stock sits beside it.
    const held = await tx.stockMovement.aggregate({
      where: {
        companyId,
        productId: input.productId,
        locationId: input.locationId,
        status: input.fromStatus,
      },
      _sum: { quantity: true },
    });
    const inBucket = held._sum.quantity ?? new Dec(0);
    if (inBucket.lessThan(moving)) {
      throw new AppError(
        400,
        `Only ${formatQuantity(inBucket)} ${product.unit} of ${input.fromStatus.toLowerCase()} stock at this location`
      );
    }

    // Leaving AVAILABLE must also respect reservations. Quarantining goods
    // that are already promised to a customer would break that promise
    // silently — the invoice would still say 5, and the shelf would no longer
    // be able to supply them.
    if (input.fromStatus === "AVAILABLE") {
      const { available } = await availableQuantity(tx, companyId, {
        productId: input.productId,
        locationId: input.locationId,
      });
      if (available.lessThan(moving)) {
        throw new AppError(
          400,
          `Only ${formatQuantity(available)} ${product.unit} is free to reclassify — the rest is reserved`
        );
      }
    }

    const note =
      input.note ?? `Reclassified ${input.fromStatus} → ${input.toStatus}`;

    // No costing call on either row. Reclassifying doesn't change what the
    // goods cost or how many are owned, so the weighted average must not move;
    // running costAdjustment here would revalue inventory for an event in
    // which nothing was bought, sold, or lost.
    const out = await tx.stockMovement.create({
      data: {
        companyId,
        productId: input.productId,
        locationId: input.locationId,
        type: "ADJUSTMENT",
        quantity: moving.negated(),
        status: input.fromStatus,
        note,
        createdById: userId,
      },
    });

    const into = await tx.stockMovement.create({
      data: {
        companyId,
        productId: input.productId,
        locationId: input.locationId,
        type: "ADJUSTMENT",
        quantity: moving,
        status: input.toStatus,
        note,
        createdById: userId,
      },
    });

    // The LEDGER records that stock moved between buckets. This records the
    // DECISION — who judged the goods damaged, or cleared them from
    // quarantine, and why. The movements alone cannot say that.
    await recordAudit(tx, {
      companyId,
      userId,
      action: "stock.reclassify",
      entity: "product",
      entityId: input.productId,
      summary: `${formatQuantity(moving)} ${product.unit} moved ${input.fromStatus} → ${input.toStatus}`,
      before: { status: input.fromStatus },
      after: {
        status: input.toStatus,
        quantity: moving.toString(),
        locationId: input.locationId,
        note: input.note ?? null,
      },
    });

    return { from: out, to: into };
  }, LOCKED_TX_OPTIONS);
}
