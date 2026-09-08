/**
 * Quantity precision on the client — the SAME rule the server enforces.
 *
 * The server's `assertPrecision` (server/src/lib/quantity.ts) is the guard:
 * anything can POST to the API, so the browser's opinion protects nothing.
 * This file exists so the user is told BEFORE the round trip, in the same
 * words, instead of typing a perfectly reasonable 67.5 and being rejected
 * after the fact.
 *
 * Both sides read the SAME field — `product.precision` — so there is one rule
 * with two readers, not two rules that can drift.
 */

/** How many decimal places a typed value actually uses. "2.50" → 2, "3" → 0. */
export function decimalPlacesOf(value: string): number {
  const dot = value.indexOf(".");
  if (dot === -1) return 0;
  return value.slice(dot + 1).replace(/0+$/, "").length;
}

/**
 * Null when the quantity is fine, otherwise the message to show.
 * Wording mirrors the server's so the two can never contradict each other.
 */
export function precisionError(
  value: string,
  product: { name: string; unit: string; precision: number }
): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null; // "empty" is a different problem
  if (!Number.isFinite(Number(trimmed))) return null; // let the input handle it

  const used = decimalPlacesOf(trimmed);
  if (used <= product.precision) return null;

  if (product.precision === 0) {
    return `${product.name} is counted in whole ${product.unit} — ${trimmed} isn't a valid quantity`;
  }
  return `${product.name} allows at most ${product.precision} decimal place${
    product.precision === 1 ? "" : "s"
  } (${product.unit}) — ${trimmed} is too precise`;
}

/** The `step` an <input type="number"> should use for this product. */
export function stepFor(precision: number): string {
  return precision <= 0 ? "1" : `0.${"0".repeat(precision - 1)}1`;
}

/**
 * Units that are almost always measured in fractions, and the decimal places
 * they usually need.
 *
 * A SUGGESTION, not a rule. It pre-fills the field when someone types "kg"
 * so the common case is right without thinking; they remain free to change
 * it, and nothing recalculates behind their back afterwards. Guessing on the
 * user's behalf and guessing SILENTLY are different things — this is the
 * first, and the field stays visible and editable so it never becomes the
 * second.
 */
const FRACTIONAL_UNITS: Record<string, number> = {
  kg: 3,
  kgs: 3,
  kilogram: 3,
  kilograms: 3,
  g: 2,
  gram: 2,
  grams: 2,
  l: 3,
  ltr: 3,
  litre: 3,
  litres: 3,
  liter: 3,
  liters: 3,
  ml: 2,
  m: 2,
  metre: 2,
  metres: 2,
  meter: 2,
  meters: 2,
  cm: 1,
  ft: 2,
  feet: 2,
  inch: 2,
  inches: 2,
  sqft: 2,
  hr: 2,
  hrs: 2,
  hour: 2,
  hours: 2,
};

/** Suggested decimal places for a unit; 0 (whole units) when unknown. */
export function suggestedPrecision(unit: string): number {
  return FRACTIONAL_UNITS[unit.trim().toLowerCase()] ?? 0;
}
