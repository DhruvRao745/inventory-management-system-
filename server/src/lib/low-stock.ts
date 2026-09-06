/**
 * THE low-stock rule. One definition, used by every screen and every alert.
 *
 * WHY THIS FILE EXISTS
 *
 * The rule was written three times, and the three copies disagreed:
 *
 *   - the reorder report resolved a per-location minimum, treated 0 as
 *     "don't track this shelf", and compared on-hand against it
 *   - `stockLevels` (the Stock page, the dashboard card, the nav badge and
 *     the Product Details location row) ignored per-location minimums
 *     entirely AND had no zero rule, so a product with its alert switched
 *     off still went red the moment a shelf reached zero available
 *   - the movement alert and the dashboard summary had the zero rule but
 *     still ignored per-location minimums
 *
 * That's how a product could show "Alert: 0" — meaning alerts are off — and
 * a location badge reading "low" at the same time, on the same page.
 *
 * THE TWO RULES, STATED ONCE
 *
 * 1. The threshold for a shelf is the LOCATION's minimum if one is set,
 *    otherwise the product's. A location that sets its own is not "adding"
 *    to the product default — it replaces it, because the whole reason
 *    ProductLocationSetting exists (PRD §11) is that a cold-storage unit and
 *    a back office need different minimums for the same product.
 *
 * 2. A threshold of zero (or less) means DO NOT TRACK. It is an off switch,
 *    not "warn me at zero". Without this, every product that has never been
 *    configured would alert the instant a shelf emptied, and the genuine
 *    warnings would be buried in noise.
 *
 * WHAT IS DELIBERATELY *NOT* IN HERE: which quantity to compare. The screens
 * judge on AVAILABLE (damaged and reserved stock can't fill an order), while
 * the reorder report judges on ON HAND (you don't buy more of something you
 * already own, whatever condition it's in). Both are correct for their
 * purpose, so the caller passes the quantity it means.
 */
import { type Decimal } from "./quantity.js";

/**
 * The minimum that actually applies to one product at one location.
 * `locationMin` is `ProductLocationSetting.minQuantity` — null when that
 * location has no opinion and inherits the product's default.
 */
export function effectiveThreshold(
  productThreshold: Decimal,
  locationMin?: Decimal | null
): Decimal {
  return locationMin ?? productThreshold;
}

/** Zero and below mean "alerts off for this shelf" — never "warn at zero". */
export function isThresholdActive(threshold: Decimal): boolean {
  return threshold.greaterThan(0);
}

/**
 * Is this shelf low? `quantity` is whatever the caller measures — available
 * for the screens, on hand for reordering.
 */
export function isLowStock(quantity: Decimal, threshold: Decimal): boolean {
  return isThresholdActive(threshold) && quantity.lessThanOrEqualTo(threshold);
}
