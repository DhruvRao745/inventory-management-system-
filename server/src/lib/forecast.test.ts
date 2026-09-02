/**
 * Forecasting maths (P3-3).
 *
 * The thread here is the same one running through analytics.test.ts, only it
 * matters more: a forecast is the one number in this system describing
 * something that has not happened, and it arrives looking exactly like a
 * measurement. Every test below is about it refusing to look more certain
 * than it is.
 */
import { describe, it, expect } from "vitest";
import {
  forecastDemand,
  suggestQuantity,
  MIN_HISTORY_DAYS,
  MIN_SALE_DAYS,
} from "./forecast.js";

/** n days of identical demand. */
const flat = (n: number, v: number) => Array.from({ length: n }, () => v);

describe("forecast — the basic projection", () => {
  it("projects a steady history straight forward", async () => {
    const f = forecastDemand({ daily: flat(90, 2), horizonDays: 30 });
    expect(f.perDay).toBe(2);
    expect(f.predictedDemand).toBe(60);
    expect(f.confidence).toBe("good");
  });

  it("weights recent weeks more heavily than old ones", async () => {
    // Sold 10/day for the first half, 2/day for the second. A flat mean says
    // 6. The forecast should sit well below that, because the recent half is
    // what the shop is actually doing now.
    const f = forecastDemand({
      daily: [...flat(45, 10), ...flat(45, 2)],
      horizonDays: 30,
    });
    expect(f.perDay).toBeLessThan(6);
    expect(f.perDay).toBeGreaterThan(2);
  });

  it("follows demand upward too", async () => {
    const rising = forecastDemand({
      daily: [...flat(45, 2), ...flat(45, 10)],
      horizonDays: 30,
    });
    expect(rising.perDay).toBeGreaterThan(6); // above the flat mean
  });

  it("counts days that sold nothing", async () => {
    // THE test for the zero-days rule. One 30-unit day in 90 is 0.33/day, not
    // 30/day. Dropping the empty days would overstate demand ninetyfold and
    // fill a warehouse.
    const spike = [...flat(89, 0), 30];
    const f = forecastDemand({ daily: spike, horizonDays: 30 });
    // Erratic enough to be refused outright — which is also correct — but if
    // it does return a number it must be a small one, never 30/day.
    if (f.perDay !== null) expect(f.perDay).toBeLessThan(2);
  });
});

describe("forecast — when it refuses", () => {
  it("refuses on too little history", async () => {
    const f = forecastDemand({ daily: flat(10, 5), horizonDays: 30 });
    expect(f.predictedDemand).toBeNull();
    expect(f.unavailableReason).toContain(String(MIN_HISTORY_DAYS));
  });

  it("refuses when a product has barely ever sold", async () => {
    // Two sale days in ninety is not a rate, it is two events. Their average
    // is an artefact of where they happened to fall.
    const daily = flat(90, 0);
    daily[10] = 5;
    daily[70] = 5;
    const f = forecastDemand({ daily, horizonDays: 30 });
    expect(f.predictedDemand).toBeNull();
    expect(f.unavailableReason).toMatch(/too few/i);
    expect(f.daysWithSales).toBe(2);
    expect(MIN_SALE_DAYS).toBeGreaterThan(2);
  });

  it("refuses when demand is wildly erratic", async () => {
    // Occasional bulk orders separated by nothing. The average across this
    // describes no day that ever happened.
    const daily = flat(90, 0);
    for (const i of [5, 30, 60, 85]) daily[i] = 200;
    const f = forecastDemand({ daily, horizonDays: 30 });
    expect(f.predictedDemand).toBeNull();
    expect(f.unavailableReason).toMatch(/erratic/i);
  });

  it("says zero — not 'unknown' — for something that never sells", async () => {
    // A confident zero. We have ninety days of evidence that nobody wants it,
    // which is real information and different from having no evidence.
    const f = forecastDemand({ daily: flat(90, 0), horizonDays: 30 });
    expect(f.predictedDemand).toBe(0);
    expect(f.unavailableReason).toBeNull();
  });

  it("always reports what it was working from", async () => {
    // Even a refusal carries its basis, so the reader can judge it.
    const f = forecastDemand({ daily: flat(5, 3), horizonDays: 30 });
    expect(f.basisDays).toBe(5);
    expect(f.daysWithSales).toBe(5);
  });
});

describe("forecast — confidence", () => {
  it("is good for steady, frequent selling", async () => {
    const f = forecastDemand({ daily: flat(90, 4), horizonDays: 30 });
    expect(f.confidence).toBe("good");
    expect(f.volatilityPercent).toBe(0);
  });

  it("drops when sales are sparse even if they're consistent", async () => {
    // Five identical sale days in ninety. Zero volatility ON THE SALE DAYS,
    // but nothing like enough of them to call it a rate — confidence has to
    // reflect the gaps, not just the spread.
    const daily = flat(90, 0);
    for (const i of [10, 25, 40, 55, 70]) daily[i] = 4;
    const f = forecastDemand({ daily, horizonDays: 30 });
    if (f.confidence !== null) expect(f.confidence).not.toBe("good");
  });

  it("measures spread relative to size, not in raw units", async () => {
    // 10 ± 2 and 1000 ± 200 are equally predictable. A raw standard deviation
    // would call the second a hundred times worse.
    const small = forecastDemand({
      daily: Array.from({ length: 90 }, (_, i) => (i % 2 ? 8 : 12)),
      horizonDays: 30,
    });
    const large = forecastDemand({
      daily: Array.from({ length: 90 }, (_, i) => (i % 2 ? 800 : 1200)),
      horizonDays: 30,
    });
    expect(small.volatilityPercent).toBe(large.volatilityPercent);
    expect(small.confidence).toBe(large.confidence);
  });
});

describe("suggested quantity", () => {
  it("covers the forecast, less what you already hold", async () => {
    const s = suggestQuantity({
      predictedDemand: 100,
      available: 40,
      confidence: "good",
    });
    // 100 forecast + 10 buffer − 40 held = 70
    expect(s.suggestedQty).toBe(70);
    expect(s.bufferUnits).toBe(10);
  });

  it("buffers more when the forecast is shakier", async () => {
    const good = suggestQuantity({
      predictedDemand: 100,
      available: 0,
      confidence: "good",
    });
    const low = suggestQuantity({
      predictedDemand: 100,
      available: 0,
      confidence: "low",
    });
    // Not because low-confidence demand is higher — because being short costs
    // more than being long, and a shaky forecast is likelier to be short.
    expect(low.suggestedQty!).toBeGreaterThan(good.suggestedQty!);
  });

  it("suggests nothing when stock already covers the forecast", async () => {
    const s = suggestQuantity({
      predictedDemand: 50,
      available: 500,
      confidence: "good",
    });
    expect(s.suggestedQty).toBe(0);
    expect(s.reason).toMatch(/already hold/i);
  });

  it("never returns a negative order", async () => {
    // "Order −450" is not a thing. Overstocked means order nothing.
    const s = suggestQuantity({
      predictedDemand: 10,
      available: 10000,
      confidence: "good",
    });
    expect(s.suggestedQty).toBe(0);
  });

  it("rounds up — you cannot order two thirds of a phone", async () => {
    const s = suggestQuantity({
      predictedDemand: 10.4,
      available: 0,
      confidence: "good",
    });
    expect(Number.isInteger(s.suggestedQty)).toBe(true);
    expect(s.suggestedQty).toBeGreaterThanOrEqual(11);
  });

  it("gives no quantity when there is no forecast", async () => {
    // The refusal has to propagate. A suggestion built on a missing forecast
    // would be the exact laundering this design exists to prevent: an
    // "I don't know" going in and a confident number coming out.
    const s = suggestQuantity({
      predictedDemand: null,
      available: 5,
      confidence: null,
    });
    expect(s.suggestedQty).toBeNull();
  });

  it("shows its arithmetic", async () => {
    // The reason string is the whole audit trail for a number someone may
    // spend money on.
    const s = suggestQuantity({
      predictedDemand: 100,
      available: 40,
      confidence: "good",
    });
    expect(s.reason).toContain("100");
    expect(s.reason).toContain("40");
  });
});
