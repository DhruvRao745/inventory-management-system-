/**
 * Demand forecasting (P3-3) — the pure maths.
 *
 * ADVISORY ONLY. Nothing in this file touches the database, and nothing that
 * calls it writes. A forecast is a sentence, not an instruction: it can say
 * "you will probably sell 40 of these" and it can suggest a number to buy, but
 * a human decides whether to buy them and the existing purchase-order flow is
 * the only thing that can act on that decision.
 *
 * That separation is not politeness. A forecast is the least reliable number
 * in the whole system — it is the only one describing something that has not
 * happened yet — and it is also the most persuasive, because it arrives
 * looking exactly like a measurement. Wiring it to anything that spends money
 * would mean the least trustworthy figure had the most authority.
 *
 * WHY A WEIGHTED MOVING AVERAGE AND NOT SOMETHING CLEVERER
 *
 * Exponential smoothing, Holt-Winters, ARIMA, a regression — all better tools
 * for a shop with three years of daily history. With a few months of sparse
 * sales they would give a more PRECISE answer to a question the data cannot
 * support, and precision reads as confidence. A weighted average over recent
 * weeks is roughly as accurate here, and it has the property that matters
 * more: you can explain it to the person acting on it in one sentence.
 *
 * THE FORECAST IS ALLOWED TO REFUSE
 *
 * Same rule as lib/analytics.ts. Too little history, too few sale events, or
 * demand so erratic that an average means nothing — each returns a refusal
 * with a reason, not a number with a shrug.
 */

/* ==================================================================== *
 * Inputs and outputs                                                    *
 * ==================================================================== */

export type ForecastInput = {
  /**
   * Units sold per day, oldest first, INCLUDING days that sold nothing.
   *
   * The zeroes are not padding. A product that sold 30 units on one day and
   * nothing for the other 89 has average demand of 0.33/day, and dropping the
   * empty days would report 30 — a ninety-fold overstatement that would have
   * someone fill a warehouse.
   */
  daily: number[];
  /** How many days ahead to project. */
  horizonDays: number;
};

export type ForecastConfidence = "good" | "fair" | "low";

export type Forecast = {
  /** Projected units over the whole horizon. null when it can't be supported. */
  predictedDemand: number | null;
  /** The same figure per day, which is what the maths actually produces. */
  perDay: number | null;
  horizonDays: number;
  confidence: ForecastConfidence | null;
  /** How much day-to-day demand bounced around, as a percentage of its mean. */
  volatilityPercent: number | null;
  /** Days of history the forecast was built from. */
  basisDays: number;
  /** Days within that history on which anything sold at all. */
  daysWithSales: number;
  /** Why there is no number, when there isn't. Null when the forecast stands. */
  unavailableReason: string | null;
};

/* ==================================================================== *
 * The thresholds, in one place so they can be argued with                *
 * ==================================================================== */

/**
 * Below this much history, recent-weeks weighting is meaningless — there are
 * no "recent weeks", only days.
 */
export const MIN_HISTORY_DAYS = 21;

/**
 * A product that has sold on two days in three months has not established a
 * rate. Its average is an artefact of where those two days happened to fall.
 */
export const MIN_SALE_DAYS = 3;

/**
 * Coefficient of variation above which demand is called erratic.
 *
 * At 150%+ the standard deviation is half again the mean, which in practice
 * means occasional large orders separated by nothing — project-driven or
 * seasonal buying. An average across that describes no real day.
 */
export const ERRATIC_VOLATILITY_PERCENT = 150;

/** Recency weights, oldest bucket first. Four buckets over the history. */
const BUCKET_WEIGHTS = [1, 2, 3, 4];

/* ==================================================================== *
 * The forecast                                                          *
 * ==================================================================== */

/**
 * Project demand over `horizonDays` from a daily history.
 *
 * The method, in full: split the history into four equal buckets oldest to
 * newest, take each bucket's mean daily demand, then combine them weighted
 * 1:2:3:4 so the most recent quarter counts four times as much as the oldest.
 * Multiply by the horizon.
 *
 * The weighting exists because demand drifts. A product that sold steadily in
 * June and stopped in August has a flat overall average that describes neither
 * month; weighting recent history lets the forecast follow the change instead
 * of averaging it away.
 */
export function forecastDemand(input: ForecastInput): Forecast {
  const daily = input.daily;
  const basisDays = daily.length;
  const daysWithSales = daily.filter((d) => d > 0).length;

  const refuse = (reason: string): Forecast => ({
    predictedDemand: null,
    perDay: null,
    horizonDays: input.horizonDays,
    confidence: null,
    volatilityPercent: null,
    basisDays,
    daysWithSales,
    unavailableReason: reason,
  });

  if (basisDays < MIN_HISTORY_DAYS) {
    return refuse(
      `Only ${basisDays} day${basisDays === 1 ? "" : "s"} of history — a forecast needs at least ${MIN_HISTORY_DAYS}.`
    );
  }

  if (daysWithSales === 0) {
    // Not the same as "we can't tell". This product genuinely has not sold,
    // and saying so is more useful than a refusal.
    return {
      predictedDemand: 0,
      perDay: 0,
      horizonDays: input.horizonDays,
      confidence: "good",
      volatilityPercent: 0,
      basisDays,
      daysWithSales: 0,
      unavailableReason: null,
    };
  }

  if (daysWithSales < MIN_SALE_DAYS) {
    return refuse(
      `Sold on only ${daysWithSales} day${daysWithSales === 1 ? "" : "s"} in the last ${basisDays} — too few to establish a rate.`
    );
  }

  // --- the weighted average -------------------------------------------
  const buckets = splitIntoBuckets(daily, BUCKET_WEIGHTS.length);
  let weightedSum = 0;
  let weightTotal = 0;
  buckets.forEach((bucket, i) => {
    if (bucket.length === 0) return;
    const bucketMean = bucket.reduce((s, x) => s + x, 0) / bucket.length;
    weightedSum += bucketMean * BUCKET_WEIGHTS[i]!;
    weightTotal += BUCKET_WEIGHTS[i]!;
  });
  const perDay = weightTotal > 0 ? weightedSum / weightTotal : 0;

  // --- how much to trust it -------------------------------------------
  const mean = daily.reduce((s, x) => s + x, 0) / basisDays;
  const variance =
    daily.reduce((s, x) => s + (x - mean) ** 2, 0) / basisDays;
  const stdDev = Math.sqrt(variance);
  // Coefficient of variation: spread relative to size. 10 ± 2 and 1000 ± 200
  // are equally predictable, and a raw standard deviation would say otherwise.
  const volatilityPercent = mean > 0 ? (stdDev / mean) * 100 : 0;

  if (volatilityPercent > ERRATIC_VOLATILITY_PERCENT) {
    return refuse(
      `Demand is too erratic to project — it swings ±${Math.round(volatilityPercent)}% around its average, ` +
        "which usually means occasional bulk orders rather than steady sales. " +
        "An average across that describes no real day."
    );
  }

  // Confidence is about the SHAPE of the history, not the size of the number.
  // Sparse selling days matter as much as volatility: 5 sale days in 90 is a
  // weak basis even if those five were consistent.
  const salesDensity = daysWithSales / basisDays;
  const confidence: ForecastConfidence =
    volatilityPercent <= 60 && salesDensity >= 0.3
      ? "good"
      : volatilityPercent <= 100 && salesDensity >= 0.1
        ? "fair"
        : "low";

  return {
    predictedDemand: round2(perDay * input.horizonDays),
    perDay: round2(perDay),
    horizonDays: input.horizonDays,
    confidence,
    volatilityPercent: round2(volatilityPercent),
    basisDays,
    daysWithSales,
    unavailableReason: null,
  };
}

/* ==================================================================== *
 * Suggested quantity                                                    *
 * ==================================================================== */

export type SuggestionInput = {
  predictedDemand: number | null;
  /** Units available to sell right now, across the locations in scope. */
  available: number;
  confidence: ForecastConfidence | null;
};

export type Suggestion = {
  /** Units to consider ordering. null when there is no forecast to base it on. */
  suggestedQty: number | null;
  /** Extra held against the forecast being wrong. */
  bufferUnits: number;
  reason: string;
};

/**
 * Turn a forecast into a quantity somebody might order.
 *
 *     suggested = predicted demand + buffer − what you already have
 *
 * THE BUFFER SCALES WITH DOUBT, NOT WITH SIZE.
 *
 * A forecast built on erratic history is more likely to be too low, and the
 * cost of the two errors is not symmetric: too much stock ties up cash, too
 * little loses the sale and possibly the customer. So a "low" confidence
 * forecast carries a bigger cushion than a "good" one.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not add supplier lead time, because the system does not record lead
 * time anywhere. Ordering 30 days of stock from a supplier who takes 3 weeks
 * to deliver leaves a gap, and this number cannot see that gap. The endpoint
 * says so rather than quietly pretending the goods arrive tomorrow.
 */
const BUFFER_BY_CONFIDENCE: Record<ForecastConfidence, number> = {
  good: 0.1,
  fair: 0.2,
  low: 0.35,
};

export function suggestQuantity(input: SuggestionInput): Suggestion {
  if (input.predictedDemand === null || input.confidence === null) {
    return {
      suggestedQty: null,
      bufferUnits: 0,
      reason: "No forecast to base a quantity on.",
    };
  }

  const bufferUnits = round2(
    input.predictedDemand * BUFFER_BY_CONFIDENCE[input.confidence]
  );
  const needed = input.predictedDemand + bufferUnits - input.available;

  if (needed <= 0) {
    return {
      suggestedQty: 0,
      bufferUnits,
      reason: `You already hold enough to cover the forecast (${input.available} available).`,
    };
  }

  return {
    suggestedQty: Math.ceil(needed),
    bufferUnits,
    reason:
      `Forecast ${input.predictedDemand} + ${bufferUnits} buffer ` +
      `− ${input.available} on hand.`,
  };
}

/* ==================================================================== *
 * Helpers                                                               *
 * ==================================================================== */

/**
 * Split a series into n roughly-equal buckets, oldest first.
 *
 * Any remainder goes to the LATER buckets, so when 90 days split into four the
 * newest bucket is never the short one. Recent data is what the weighting
 * exists to favour; giving it fewer days would work against that.
 */
function splitIntoBuckets(series: number[], n: number): number[][] {
  const size = Math.floor(series.length / n);
  const remainder = series.length % n;
  const buckets: number[][] = [];
  let i = 0;
  for (let b = 0; b < n; b++) {
    // Buckets from (n - remainder) onwards take one extra day.
    const take = size + (b >= n - remainder ? 1 : 0);
    buckets.push(series.slice(i, i + take));
    i += take;
  }
  return buckets;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
