/**
 * Money formatting — one place, used everywhere.
 *
 * Intl.NumberFormat is built into every browser and knows how each
 * currency is written: formatMoney(675, "INR") → "₹675",
 * formatMoney(675, "USD") → "$675", "EUR" → "€675", and so on.
 * No currency table to maintain — the browser carries it.
 */
/**
 * Quantities arrive as STRINGS since P1-2 — they're Decimal(18,4) in the
 * database, for the same reason money is: 0.1 + 0.2 isn't 0.3 in binary
 * floating point, and stock that drifts is worse than useless.
 *
 * JS has no decimal type, so the client converts to number at the very edge —
 * for display and for arithmetic that only feeds a screen. Anything the
 * database must believe is computed server-side in Decimal and sent back.
 */
export function qtyNum(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Display a quantity: "5" stays "5", "2.5000" becomes "2.5".
 * Trailing zeros are noise — nobody wants to read "5.0000 pcs".
 */
export function formatQty(
  value: string | number | null | undefined,
  unit?: string
): string {
  const n = qtyNum(value);
  // up to 4 dp (the column's scale), but no trailing zeros
  const text = n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return unit ? `${text} ${unit}` : text;
}

export function formatMoney(
  value: number,
  currency = "INR",
  maxDecimals = 2
) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: maxDecimals,
    }).format(value);
  } catch {
    // unknown code? fall back gracefully rather than crash
    return `${currency} ${value.toFixed(maxDecimals)}`;
  }
}
