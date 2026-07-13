/**
 * Money formatting — one place, used everywhere.
 *
 * Intl.NumberFormat is built into every browser and knows how each
 * currency is written: formatMoney(675, "INR") → "₹675",
 * formatMoney(675, "USD") → "$675", "EUR" → "€675", and so on.
 * No currency table to maintain — the browser carries it.
 */
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
