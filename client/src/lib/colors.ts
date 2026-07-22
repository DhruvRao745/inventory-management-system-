/**
 * The functional color system — "colourful" with meaning.
 * Every hue is assigned to a CONCEPT, so color carries information
 * instead of decoration. Works on both themes (mid-500 saturation
 * reads well on light and dark).
 */

/** Stable palette for auto-colored things (categories). */
export const PALETTE = [
  "#3b82f6", // blue
  "#a855f7", // purple
  "#ec4899", // pink
  "#f59e0b", // amber
  "#10b981", // emerald
  "#06b6d4", // cyan
  "#f97316", // orange
  "#8b5cf6", // violet
];

/** Same name → same color, forever. No storage needed. */
export function hashColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

/** One color per movement type — learn them once, read history at a glance. */
export const TYPE_COLORS: Record<string, string> = {
  PURCHASE: "#10b981", // emerald — goods arriving
  SALE: "#ef4444", // red — goods leaving
  RETURN_IN: "#06b6d4", // cyan — coming back to us
  RETURN_OUT: "#f97316", // orange — going back to supplier
  ADJUSTMENT: "#f59e0b", // amber — corrections
  TRANSFER_IN: "#3b82f6", // blue — internal, arriving
  TRANSFER_OUT: "#8b5cf6", // violet — internal, leaving
};
