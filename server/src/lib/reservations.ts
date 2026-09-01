/**
 * Reservations — stock that is spoken for but has not moved (P2-1).
 *
 * THE ONE IDEA
 *
 *     On hand   = SUM(movements)             — what is physically on the shelf
 *     Reserved  = SUM(active reservations)   — what someone has claimed
 *     Available = On hand − Reserved         — what may still be promised away
 *
 * A reservation writes NOTHING to the ledger. PRD §13 is explicit about this:
 * "A future reservation must not immediately subtract physical stock." The
 * goods are still there. If reserving deducted stock, a stocktake would report
 * a variance against goods sitting in plain sight, and the valuation would
 * drop for inventory the company still owns.
 *
 * Think of a table booked at a restaurant. The table is still in the room and
 * still belongs to the restaurant. It just can't be given to anyone else.
 *
 * WHY THIS FILE TAKES LOCKS (the part that is easy to get wrong)
 *
 * Reserving has exactly the same shape as selling:
 *
 *     read availability  →  check it's enough  →  write a row
 *
 * which is the read-check-write race P0 fixed for the ledger. If reserving
 * skipped the advisory lock, two simultaneous reservations would both read
 * "10 available", both pass, and both write — and the company would have
 * promised 16 units of a 10-unit shelf. Nothing would be negative anywhere;
 * the ledger would look perfect. The lie would only surface when the second
 * customer turned up.
 *
 * So reservations take the SAME lock, on the SAME key, as stock writes:
 * `stock:<company>:<product>:<location>`. One key, one queue, whether the
 * writer is moving stock or promising it. Two different keys would be two
 * separate queues that never see each other, which is the same as no lock.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import type { Tx } from "./locks.js";

const D = Prisma.Decimal;
type Decimal = Prisma.Decimal;

/** One shelf. Same shape as StockKey in locks.ts, on purpose. */
export type ShelfKey = { productId: string; locationId: string };

/**
 * How much of this shelf is currently spoken for.
 *
 * Only ACTIVE reservations count. CONSUMED ones already became movements —
 * counting them too would subtract the same goods twice, once as a promise and
 * again as a sale. RELEASED ones hold nothing by definition.
 *
 * Expired reservations are excluded here rather than being cleaned up first,
 * so an expiry is honoured the instant it passes even if no sweeper has run.
 * A promise that has run out has stopped holding stock, whether or not a
 * background job has noticed yet.
 */
export async function reservedQuantity(
  client: Tx | typeof prisma,
  companyId: string,
  key: ShelfKey,
  options: { excludeSource?: { sourceType: string; sourceId: string } } = {}
): Promise<Decimal> {
  const now = new Date();
  const result = await client.stockReservation.aggregate({
    where: {
      companyId,
      productId: key.productId,
      locationId: key.locationId,
      status: "ACTIVE",
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      ...(options.excludeSource
        ? {
            NOT: {
              sourceType: options.excludeSource.sourceType,
              sourceId: options.excludeSource.sourceId,
            },
          }
        : {}),
    },
    _sum: { quantity: true },
  });
  return result._sum.quantity ?? new D(0);
}

/**
 * On hand minus what's reserved.
 *
 * `excludeSource` exists for one specific and necessary case: issuing an
 * invoice. A draft invoice reserves its own lines, so by the time it is
 * issued the stock it needs is already reserved — BY ITSELF. Counting that
 * against it would mean every draft blocks its own issue, and the more
 * carefully you reserved, the more certainly you'd be refused.
 *
 * So the issuing path asks "what is available, ignoring my own hold?".
 */
export async function availableQuantity(
  client: Tx | typeof prisma,
  companyId: string,
  key: ShelfKey,
  options: { excludeSource?: { sourceType: string; sourceId: string } } = {}
): Promise<{
  onHand: Decimal;
  sellable: Decimal;
  reserved: Decimal;
  available: Decimal;
}> {
  const [onHandAgg, sellableAgg, reserved] = await Promise.all([
    // Everything we OWN here, whatever condition it's in. This is the figure
    // valuation and stocktakes use — a crushed box is still company property.
    client.stockMovement.aggregate({
      where: {
        companyId,
        productId: key.productId,
        locationId: key.locationId,
      },
      _sum: { quantity: true },
    }),
    // Only what we may actually SELL (P2-2). Damaged and quarantined stock is
    // owned but must never fill an order.
    client.stockMovement.aggregate({
      where: {
        companyId,
        productId: key.productId,
        locationId: key.locationId,
        status: "AVAILABLE",
      },
      _sum: { quantity: true },
    }),
    reservedQuantity(client, companyId, key, options),
  ]);

  const onHand = onHandAgg._sum.quantity ?? new D(0);
  const sellable = sellableAgg._sum.quantity ?? new D(0);
  // Availability is built on SELLABLE, not on hand. Reserving against damaged
  // stock would promise goods that can never be delivered.
  return { onHand, sellable, reserved, available: sellable.minus(reserved) };
}

/**
 * Replace whatever a source holds with a new set of holds.
 *
 * Editing a draft invoice is a REPLACE, not an add: the invoice's claim is
 * whatever its lines currently say. Releasing the old holds and writing the
 * new ones inside one transaction means the invoice can never briefly hold
 * both the old and new quantities — which, on a shelf with little spare stock,
 * would make an ordinary edit fail for no reason a user could understand.
 *
 * MUST be called inside a transaction that already holds the stock locks for
 * every key involved, old and new.
 */
export async function replaceReservations(
  tx: Tx,
  companyId: string,
  userId: string,
  source: { sourceType: string; sourceId: string },
  holds: { productId: string; locationId: string; quantity: Decimal }[]
): Promise<void> {
  await releaseReservations(tx, companyId, source);

  const positive = holds.filter((h) => h.quantity.greaterThan(0));
  if (positive.length === 0) return;

  await tx.stockReservation.createMany({
    data: positive.map((h) => ({
      companyId,
      productId: h.productId,
      locationId: h.locationId,
      quantity: h.quantity,
      status: "ACTIVE" as const,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      createdById: userId,
    })),
  });
}

/** Let go of every ACTIVE hold belonging to a source. */
export async function releaseReservations(
  tx: Tx,
  companyId: string,
  source: { sourceType: string; sourceId: string }
): Promise<number> {
  const { count } = await tx.stockReservation.updateMany({
    where: {
      companyId,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      status: "ACTIVE",
    },
    data: { status: "RELEASED", releasedAt: new Date() },
  });
  return count;
}

/**
 * The promise became a real movement.
 *
 * Marked CONSUMED rather than deleted, so "this invoice held 5 units from
 * Tuesday until it was issued on Thursday" stays answerable. Deleting the row
 * would destroy the only record that the hold ever existed.
 */
export async function consumeReservations(
  tx: Tx,
  companyId: string,
  source: { sourceType: string; sourceId: string }
): Promise<number> {
  const { count } = await tx.stockReservation.updateMany({
    where: {
      companyId,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      status: "ACTIVE",
    },
    data: { status: "CONSUMED", consumedAt: new Date() },
  });
  return count;
}

/**
 * Sweep reservations whose expiry has passed.
 *
 * Purely tidying. `reservedQuantity` already ignores expired rows, so
 * availability is correct whether or not this ever runs — the sweep just stops
 * dead rows accumulating and keeps the reservations list honest to read.
 */
export async function expireStaleReservations(
  companyId: string
): Promise<number> {
  const { count } = await prisma.stockReservation.updateMany({
    where: {
      companyId,
      status: "ACTIVE",
      expiresAt: { not: null, lte: new Date() },
    },
    data: { status: "RELEASED", releasedAt: new Date() },
  });
  return count;
}
