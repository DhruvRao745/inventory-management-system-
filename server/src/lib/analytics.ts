/**
 * Inventory analytics — the pure maths (P3-2).
 *
 * No database access, for the same reason lib/gst.ts has none: these are
 * formulas with opinions baked into them, and opinions should be testable in
 * isolation. The services fetch; this decides what the numbers mean.
 *
 * EVERY FUNCTION HERE CAN RETURN "I DON'T KNOW"
 *
 * That is the design point. Analytics invites confident-looking numbers built
 * on nothing — a turnover ratio from two weeks of data, an ABC classification
 * of four products, a "declining" trend drawn from three sales. Those figures
 * are worse than blanks, because a blank prompts a question and a wrong number
 * ends one.
 *
 * So each calculation reports its own basis, and returns null rather than
 * inventing a figure it can't support.
 */
import { Prisma } from "@prisma/client";

const D = Prisma.Decimal;
type Decimal = Prisma.Decimal;

/* ==================================================================== *
 * Inventory turnover                                                    *
 * ==================================================================== */

/**
 * How many times the stock was sold and replaced over a period.
 *
 *     Turnover = COGS ÷ AVERAGE inventory value
 *
 * THE WORD "AVERAGE" IS THE WHOLE PROBLEM.
 *
 * The tempting implementation divides by TODAY'S stock value, because that is
 * the number sitting in the database. It is also wrong the moment stock levels
 * moved during the period — which is always, since selling is what turnover
 * measures. A shop that ran its stock down to nearly nothing would report a
 * spectacular ratio purely because the denominator collapsed.
 *
 * The ledger is append-only, so stock at any past date is exactly
 * `SUM(movements up to that date)` — not an estimate, a reconstruction. The
 * caller supplies opening and closing values obtained that way, and the
 * average of the two is the standard basis.
 *
 * DAYS OF INVENTORY is the same fact stated usefully. "Turnover 4.2" means
 * little to most people; "you hold about 87 days of stock" is immediately
 * either fine or alarming.
 */
export type TurnoverInput = {
  cogs: Decimal;
  openingValue: Decimal;
  closingValue: Decimal;
  periodDays: number;
  /** Sales in the period, whether or not their cost is known. */
  salesCount: number;
  /**
   * How many of those carry no recorded cost.
   *
   * NOT a hypothetical. Stock received before weighted-average costing shipped
   * has no cost history, and `backfill-costs.ts` deliberately refuses to invent
   * one for a completed sale (PRD §7). So `costAtTime` is legitimately zero on
   * older rows, and COGS built from them understates by exactly that much.
   */
  salesMissingCost: number;
  /**
   * Was any stock actually on a shelf, whatever it was worth?
   *
   * A stock VALUE of zero has two causes and they are opposites: an empty
   * warehouse, or a full one whose contents carry no recorded cost. Legacy
   * stock is the second, and the difference is not cosmetic — one means "you
   * held nothing", the other means "we can't price what you held".
   */
  heldStock: boolean;
};

export type Turnover = {
  cogs: number;
  averageValue: number;
  /** null when the ratio can't be supported — not zero, which reads as bad. */
  ratio: number | null;
  /** How long current stock would last at this rate. */
  daysOfInventory: number | null;
  /**
   * Why the ratio is missing, in words, when it is.
   *
   * The caller must not infer the reason from the shape of the numbers. Doing
   * that is what produced the bug this field exists to prevent: the UI saw
   * COGS of zero, concluded "nothing sold", and printed that under a chart
   * showing 129 units sold. Zero COGS and zero sales look identical from the
   * outside and are completely different facts.
   */
  unavailableReason: string | null;
  /** Surfaced so a reader can see how complete the COGS figure is. */
  salesMissingCost: number;
};

export function inventoryTurnover(input: TurnoverInput): Turnover {
  const average = input.openingValue
    .plus(input.closingValue)
    .dividedBy(2)
    .toDecimalPlaces(4);

  const base = {
    cogs: Number(input.cogs.toDecimalPlaces(2)),
    salesMissingCost: input.salesMissingCost,
  };

  // No stock VALUE across the whole period. Two different facts land here and
  // they must not be reported as the same one.
  if (average.lessThanOrEqualTo(0)) {
    return {
      ...base,
      averageValue: 0,
      ratio: null,
      daysOfInventory: null,
      unavailableReason: input.heldStock
        ? "Stock was held, but none of it has a recorded cost — so there is " +
          "no stock value to divide into, and the ratio cannot be calculated. " +
          "Stock received before cost tracking started has no cost to report."
        : "No stock was held at any point in this period.",
    };
  }

  // Stock was held and nothing was sold. A genuine zero — the stock really did
  // not turn over — so it is reported as zero rather than as unknown.
  if (input.salesCount === 0) {
    return {
      ...base,
      averageValue: Number(average),
      ratio: 0,
      daysOfInventory: null, // "never runs out" is not a number of days
      unavailableReason: null,
    };
  }

  // Sales happened, but NONE of them recorded what the goods cost. COGS is
  // therefore unknown, not zero, and a ratio built on it would be a confident
  // claim that the stock never moved — the opposite of the truth.
  if (input.salesMissingCost >= input.salesCount) {
    return {
      ...base,
      averageValue: Number(average),
      ratio: null,
      daysOfInventory: null,
      unavailableReason:
        `${input.salesCount} sale${input.salesCount === 1 ? "" : "s"} in this ` +
        "period, but none of them recorded what the goods cost — so cost of " +
        "goods sold, and the ratio built on it, cannot be calculated. Sales " +
        "made before cost tracking started have no cost to report, and one " +
        "will not be invented for them.",
    };
  }

  const ratio = input.cogs.dividedBy(average);

  return {
    ...base,
    averageValue: Number(average),
    ratio: Number(ratio.toDecimalPlaces(2)),
    // Turned 4 times in 90 days → roughly 22 days of stock on hand.
    daysOfInventory: ratio.greaterThan(0)
      ? Math.round(input.periodDays / Number(ratio))
      : null,
    unavailableReason: null,
  };
}

/* ==================================================================== *
 * ABC classification                                                    *
 * ==================================================================== */

/**
 * Sort products into A / B / C by how much of the total they account for.
 *
 * The Pareto observation: a small number of lines usually carry most of the
 * value, and they deserve most of the attention — tighter stock control,
 * closer supplier relationships, more frequent counting.
 *
 *   A — the products making up the first 80% of value
 *   B — the next 15%
 *   C — the remaining 5%, which is usually most of the catalogue by count
 *
 * The cut-offs are on CUMULATIVE share, so a single product worth 90% of
 * revenue is an A on its own and everything else falls below it. That is the
 * intended behaviour, not an edge case.
 *
 * WHY THIS REFUSES TO RUN ON A TINY CATALOGUE
 *
 * Classifying six products into three bands tells you nothing you couldn't see
 * by looking at six products. Worse, it dresses an arbitrary split in the
 * language of analysis. Below a threshold this returns the ranking without
 * bands, and says so.
 */
export type AbcItem = { id: string; label: string; value: number };
export type AbcRow = AbcItem & {
  share: number;
  cumulativeShare: number;
  class: "A" | "B" | "C" | null;
};

export const ABC_MINIMUM_ITEMS = 10;

export function abcAnalysis(items: AbcItem[]): {
  rows: AbcRow[];
  total: number;
  classified: boolean;
  note: string | null;
} {
  const positive = items.filter((i) => i.value > 0);
  const total = positive.reduce((s, i) => s + i.value, 0);

  if (positive.length === 0 || total <= 0) {
    return { rows: [], total: 0, classified: false, note: "No sales in this period." };
  }

  const sorted = [...positive].sort((a, b) => b.value - a.value);
  const classify = positive.length >= ABC_MINIMUM_ITEMS;

  let running = 0;
  const rows: AbcRow[] = sorted.map((item) => {
    const share = (item.value / total) * 100;

    // Banded on the cumulative share BEFORE this item, not after it.
    //
    // The difference only shows up on the item that straddles a boundary, and
    // there it matters a great deal. Take one product worth 81% of revenue:
    // banding on the running total after it gives 81 > 80, so the single most
    // important line in the business is a B, and nothing is an A at all.
    //
    // Asking "had we already covered 80% before reaching this one?" gets it
    // right. The first item always has 0 behind it, so the top line is always
    // an A — which is the only sane reading of "the products making up the
    // first 80% of value".
    const before = running;
    running += share;

    return {
      ...item,
      share: Math.round(share * 100) / 100,
      cumulativeShare: Math.round(running * 100) / 100,
      class: !classify ? null : before < 80 ? "A" : before < 95 ? "B" : "C",
    };
  });

  return {
    rows,
    total: Math.round(total * 100) / 100,
    classified: classify,
    note: classify
      ? null
      : `Ranked but not classified — ABC needs at least ${ABC_MINIMUM_ITEMS} selling products to mean anything.`,
  };
}

/* ==================================================================== *
 * Trend                                                                 *
 * ==================================================================== */

/**
 * Is demand rising, falling, or flat?
 *
 * Compares the second half of a series against the first. Deliberately crude:
 * with the data volumes here, a regression would give a more precise answer to
 * a question the data cannot support.
 *
 * THE DEAD ZONE IS THE IMPORTANT PART.
 *
 * Small samples wander. Two weeks at 10 units and 11 units is not a 10% growth
 * trend, it is noise, and calling it growth would have someone order stock on
 * the strength of one extra sale. Anything inside ±15% is reported as "steady",
 * and a series too short to halve meaningfully returns "unknown".
 */
export type Trend = {
  direction: "rising" | "falling" | "steady" | "unknown";
  changePercent: number | null;
  firstHalf: number;
  secondHalf: number;
};

/** Below this, differences are noise rather than signal. */
const TREND_DEAD_ZONE_PERCENT = 15;
/** Fewer points than this and halving the series is meaningless. */
const TREND_MINIMUM_POINTS = 6;

export function trendOf(series: number[]): Trend {
  if (series.length < TREND_MINIMUM_POINTS) {
    return {
      direction: "unknown",
      changePercent: null,
      firstHalf: 0,
      secondHalf: 0,
    };
  }

  const mid = Math.floor(series.length / 2);
  const first = series.slice(0, mid);
  const second = series.slice(mid);

  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;

  const a = mean(first);
  const b = mean(second);

  // Growth from nothing has no percentage. Reported as unknown rather than as
  // an infinite or arbitrary figure.
  if (a === 0) {
    return {
      direction: b > 0 ? "rising" : "unknown",
      changePercent: null,
      firstHalf: Math.round(a * 100) / 100,
      secondHalf: Math.round(b * 100) / 100,
    };
  }

  const change = ((b - a) / a) * 100;

  return {
    direction:
      Math.abs(change) < TREND_DEAD_ZONE_PERCENT
        ? "steady"
        : change > 0
          ? "rising"
          : "falling",
    changePercent: Math.round(change * 100) / 100,
    firstHalf: Math.round(a * 100) / 100,
    secondHalf: Math.round(b * 100) / 100,
  };
}

/* ==================================================================== *
 * Dead and slow-moving stock                                            *
 * ==================================================================== */

/**
 * How stale is this product?
 *
 * DEAD means held and never sold at all — the worst case, because it has
 * consumed cash and shelf space and returned nothing. It is separated from
 * merely slow stock because the remedy differs: slow stock might need a
 * promotion, dead stock probably needs writing off or returning.
 *
 * A product with no stock is not dead, it is simply absent — reporting it
 * would fill the list with things that cost nothing to hold.
 */
export type Staleness = "dead" | "stale" | "slow" | "moving";

export function classifyStaleness(params: {
  onHand: number;
  daysSinceLastSale: number | null;
  slowAfterDays: number;
  staleAfterDays: number;
}): Staleness | null {
  if (params.onHand <= 0) return null; // nothing held: not a problem

  // Never sold, but we are holding it. This is the one that costs money
  // quietly, because it never appears in any sales report by definition.
  if (params.daysSinceLastSale === null) return "dead";

  if (params.daysSinceLastSale >= params.staleAfterDays) return "stale";
  if (params.daysSinceLastSale >= params.slowAfterDays) return "slow";
  return "moving";
}
