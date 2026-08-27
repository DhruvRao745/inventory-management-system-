/**
 * Weighted-average costing and COGS (P1-3).
 *
 * WHAT WAS WRONG BEFORE
 *
 * The system had one `Product.costPrice` — whatever someone last typed in.
 * Reports multiplied stock by it and called the result "value", and
 * `sellingPrice − costPrice` and called that "profit". Both are guesses.
 *
 * Change `costPrice` today and every historical margin in the system silently
 * changes with it. A sale you made in March, at a real cost you actually paid,
 * suddenly reports a different profit because a delivery in April was dearer.
 * That is not an accounting system; it is a spreadsheet that rewrites its own
 * past.
 *
 * HOW WEIGHTED AVERAGE WORKS
 *
 * Buy 10 at ₹100, then 10 at ₹120. You do not have "10 cheap ones and 10 dear
 * ones" — you have 20 units that cost you ₹2,200, so each is worth ₹110:
 *
 *     New Average = Total Inventory Value / Total Inventory Quantity
 *
 * Sell 5 and the COGS is 5 × ₹110 = ₹550. The average does NOT move when you
 * sell — selling removes value at the current average, it doesn't re-price
 * what's left.
 *
 * THE RULE THAT MAKES IT HONEST
 *
 * PRD §7: "The historical cost used for a completed sale must not change
 * simply because a later purchase changes the average cost."
 *
 * We satisfy that structurally rather than by discipline: the average in force
 * is stamped onto the movement row as `costAtTime` at the instant of the sale.
 * Movements are append-only, so that number can never be rewritten. COGS for
 * any period is then just a sum over rows that already hold their own answer.
 *
 * SCOPE: COMPANY-WIDE, NOT PER LOCATION
 *
 * One average per product across every location. This is the PRD's formula,
 * and it makes transfers cost-neutral: moving your own stock between your own
 * shelves shouldn't change what it cost you. Transfers therefore skip costing
 * entirely.
 *
 * CONCURRENCY
 *
 * Every function here read-modify-writes `Product.avgCost`/`stockValue`, so
 * each MUST run inside a transaction holding `lockCost(companyId, [productId])`.
 * `lockStock` is not enough — it's keyed per location, and the average is
 * company-wide. See lib/locks.ts.
 */
import { Prisma } from "@prisma/client";
import { AppError } from "../middleware/error.js";
import type { Tx } from "./locks.js";

const D = Prisma.Decimal;
type Decimal = Prisma.Decimal;

/** Unit costs carry 6 dp; stock value carries 4. Keep it in one place. */
const COST_DP = 6;
const VALUE_DP = 4;

/**
 * Stock coming IN at a known purchase price — the only event that moves the
 * average.
 *
 * Returns the cost stamped on the movement (the purchase price itself, since
 * that is literally what this unit cost).
 */
export async function costStockIn(
  tx: Tx,
  companyId: string,
  productId: string,
  quantity: Decimal,
  unitCost: Decimal
): Promise<Decimal> {
  if (quantity.lessThanOrEqualTo(0)) {
    throw new AppError(400, "Incoming quantity must be positive");
  }

  const product = await tx.product.findFirst({
    where: { id: productId, companyId },
    select: { stockValue: true, avgCost: true },
  });
  if (!product) throw new AppError(404, "Product not found");

  const addedValue = quantity.times(unitCost);
  const newValue = product.stockValue.plus(addedValue);

  // Quantity on hand is derived from the ledger, never stored — so recover it
  // from the value we're tracking rather than trusting a second counter that
  // could drift from the first.
  const priorQty = product.avgCost.isZero()
    ? new D(0)
    : product.stockValue.dividedBy(product.avgCost);
  const newQty = priorQty.plus(quantity);

  const newAvg = newQty.greaterThan(0)
    ? newValue.dividedBy(newQty).toDecimalPlaces(COST_DP)
    : product.avgCost; // nothing on hand: keep the last known average

  await tx.product.update({
    where: { id: productId },
    data: {
      stockValue: newValue.toDecimalPlaces(VALUE_DP),
      avgCost: newAvg,
    },
  });

  return unitCost.toDecimalPlaces(COST_DP);
}

/**
 * Stock going OUT. Removes value at the CURRENT average and returns that
 * average so the caller can stamp it on the movement.
 *
 * The average itself is deliberately left alone: selling doesn't re-price what
 * remains on the shelf.
 */
export async function costStockOut(
  tx: Tx,
  companyId: string,
  productId: string,
  quantity: Decimal
): Promise<Decimal> {
  if (quantity.lessThanOrEqualTo(0)) {
    throw new AppError(400, "Outgoing quantity must be positive");
  }

  const product = await tx.product.findFirst({
    where: { id: productId, companyId },
    select: { stockValue: true, avgCost: true },
  });
  if (!product) throw new AppError(404, "Product not found");

  const costAtTime = product.avgCost;
  const removedValue = quantity.times(costAtTime);

  // Never let value go negative. It can only happen through rounding on the
  // last few units; clamping to zero is right because an empty shelf is worth
  // nothing, and a negative asset would poison every report downstream.
  const newValue = Prisma.Decimal.max(
    new D(0),
    product.stockValue.minus(removedValue)
  );

  await tx.product.update({
    where: { id: productId },
    data: { stockValue: newValue.toDecimalPlaces(VALUE_DP) },
  });

  return costAtTime;
}

/**
 * Stock coming back in at a KNOWN historical cost — a cancelled sale or a
 * customer return.
 *
 * Uses the cost the units left at, not today's average. Returning goods must
 * restore the exact value that leaving them removed; valuing a return at a
 * newer, higher average would conjure profit out of a cancellation.
 */
export async function costReturnIn(
  tx: Tx,
  companyId: string,
  productId: string,
  quantity: Decimal,
  originalCost: Decimal
): Promise<Decimal> {
  const product = await tx.product.findFirst({
    where: { id: productId, companyId },
    select: { stockValue: true },
  });
  if (!product) throw new AppError(404, "Product not found");

  await tx.product.update({
    where: { id: productId },
    data: {
      stockValue: product.stockValue
        .plus(quantity.times(originalCost))
        .toDecimalPlaces(VALUE_DP),
    },
  });

  // Average is unchanged: value and quantity both go back by the same ratio
  // they left at, so the mean is undisturbed.
  return originalCost.toDecimalPlaces(COST_DP);
}

/**
 * An adjustment: found stock or lost stock, both valued at today's average
 * because we have no better information about what those specific units cost.
 */
export async function costAdjustment(
  tx: Tx,
  companyId: string,
  productId: string,
  signedQuantity: Decimal
): Promise<Decimal> {
  const product = await tx.product.findFirst({
    where: { id: productId, companyId },
    select: { stockValue: true, avgCost: true },
  });
  if (!product) throw new AppError(404, "Product not found");

  const delta = signedQuantity.times(product.avgCost);
  const newValue = Prisma.Decimal.max(new D(0), product.stockValue.plus(delta));

  await tx.product.update({
    where: { id: productId },
    data: { stockValue: newValue.toDecimalPlaces(VALUE_DP) },
  });

  return product.avgCost;
}

/**
 * Cost of Goods Sold for a period, straight from the ledger.
 *
 * Every SALE movement already carries the cost that applied when it happened,
 * so this is a sum over facts — not a recomputation that could disagree with
 * what the invoice said at the time. That is the whole point of `costAtTime`.
 */
export async function cogsForPeriod(
  tx: Tx,
  companyId: string,
  from: Date,
  to: Date,
  productId?: string
): Promise<{ cogs: Decimal; unitsSold: Decimal }> {
  const sales = await tx.stockMovement.findMany({
    where: {
      companyId,
      type: "SALE",
      createdAt: { gte: from, lte: to },
      ...(productId ? { productId } : {}),
    },
    select: { quantity: true, costAtTime: true },
  });

  let cogs = new D(0);
  let unitsSold = new D(0);
  for (const s of sales) {
    const qty = s.quantity.abs(); // sales are stored negative
    unitsSold = unitsSold.plus(qty);
    if (s.costAtTime) cogs = cogs.plus(qty.times(s.costAtTime));
  }

  return { cogs: cogs.toDecimalPlaces(VALUE_DP), unitsSold };
}

/** Gross profit and margin from revenue and COGS. */
export function grossProfit(revenue: Decimal, cogs: Decimal) {
  const profit = revenue.minus(cogs);
  // Margin is undefined with no revenue — report 0 rather than dividing by it.
  const margin = revenue.greaterThan(0)
    ? profit.dividedBy(revenue).times(100).toDecimalPlaces(2)
    : new D(0);
  return { profit: profit.toDecimalPlaces(2), margin };
}
