/**
 * Quantities — one place, used everywhere (P1-2).
 *
 * WHY QUANTITIES ARE DECIMAL, NOT NUMBER
 *
 * Money has always been `Decimal` here for the obvious reason: 0.1 + 0.2 is
 * 0.30000000000000004 in binary floating point, and an invoice that's a
 * hundredth of a rupee out is a bug you'll spend a day chasing.
 *
 * Quantities have exactly the same problem the moment you stock anything by
 * weight or volume. Sell 0.1 kg three times from a 1 kg bag using JS numbers
 * and the bag has 0.7000000000000001 kg left — forever, and every report that
 * touches it inherits the lie. So quantities are `Decimal(18,4)` and all
 * arithmetic goes through Decimal methods.
 *
 * WHY PRECISION IS PER PRODUCT
 *
 * `Decimal(18,4)` says the DATABASE can hold four decimal places. It says
 * nothing about whether a given product SHOULD. You cannot sell half a
 * stapler, and nobody wants 0.333333 kg of rice booked in — that leaves dust
 * in the ledger that can never be sold or counted.
 *
 * So each product carries `precision`: 0 for staplers, 3 for rice. This file
 * enforces it. Zod can't, because Zod validates the request before we know
 * which product it's for.
 */
import { Prisma } from "@prisma/client";
import { AppError } from "../middleware/error.js";

export type Decimal = Prisma.Decimal;
export const Dec = Prisma.Decimal;

/** Turn anything the API might hand us into a Decimal, safely. */
export function toDecimal(value: Prisma.Decimal | number | string): Decimal {
  return value instanceof Prisma.Decimal
    ? value
    : new Prisma.Decimal(value);
}

/** How many decimal places a value actually uses. `2.50` → 1, `3` → 0. */
export function decimalPlaces(value: Decimal): number {
  return value.decimalPlaces();
}

/**
 * Reject a quantity that's finer than the product allows.
 *
 * The error names the unit, because "Quantity may have at most 0 decimal
 * places" is meaningless to someone at a counter, whereas "Blue Pen is
 * counted in whole pcs" tells them exactly what to type.
 */
export function assertPrecision(
  quantity: Decimal,
  product: { name: string; unit: string; precision: number }
): void {
  if (decimalPlaces(quantity) <= product.precision) return;

  if (product.precision === 0) {
    throw new AppError(
      400,
      `${product.name} is counted in whole ${product.unit} — ${quantity.toString()} isn't a valid quantity`
    );
  }
  throw new AppError(
    400,
    `${product.name} allows at most ${product.precision} decimal place${
      product.precision === 1 ? "" : "s"
    } (${product.unit}) — ${quantity.toString()} is too precise`
  );
}

/**
 * Parse a client-supplied quantity and check it against the product.
 *
 * Everything arriving over HTTP funnels through here, so there is exactly one
 * answer to "is this a legal quantity for this product?".
 */
export function parseQuantity(
  value: number | string,
  product: { name: string; unit: string; precision: number },
  opts: { allowNegative?: boolean } = {}
): Decimal {
  let q: Decimal;
  try {
    q = new Prisma.Decimal(value);
  } catch {
    throw new AppError(400, `"${value}" isn't a valid quantity`);
  }

  if (!q.isFinite()) throw new AppError(400, "Quantity must be a real number");
  if (q.isZero()) throw new AppError(400, "Quantity can't be zero");
  if (!opts.allowNegative && q.isNegative()) {
    throw new AppError(400, "Quantity must be positive");
  }

  assertPrecision(q.abs(), product);
  return q;
}

/**
 * Format for display/messages. Trims pointless trailing zeros so a whole
 * number reads "5" rather than "5.0000", but keeps genuine decimals intact.
 */
export function formatQuantity(value: Decimal | number | string): string {
  const d = toDecimal(value);
  return d.toDecimalPlaces(4).toString();
}

/** Sum a column of Decimals without ever touching a JS number. */
export function sumDecimals(values: (Decimal | null | undefined)[]): Decimal {
  return values.reduce<Decimal>(
    (acc, v) => (v ? acc.plus(v) : acc),
    new Prisma.Decimal(0)
  );
}

/**
 * Convert a pack quantity into base units: 2 boxes of 12 → 24 pieces.
 * Returns the input unchanged when the product has no pack defined.
 */
export function packsToUnits(
  packs: Decimal,
  product: { unitsPerPack: Decimal | null }
): Decimal {
  return product.unitsPerPack ? packs.times(product.unitsPerPack) : packs;
}
