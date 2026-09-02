/**
 * Analytics maths (P3-2).
 *
 * Pure functions, no database — the same reason lib/gst.ts is separate. These
 * encode judgement calls (when is a trend real? when is a catalogue big enough
 * to classify?) and a judgement call should be visible and testable, not
 * buried in a query.
 *
 * The thread running through every test here: THE FUNCTION IS ALLOWED TO SAY
 * "I DON'T KNOW". Analytics is the part of a system most likely to produce a
 * confident number from nothing, and a wrong number ends a question that a
 * blank would have started.
 */
import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import {
  inventoryTurnover,
  abcAnalysis,
  trendOf,
  classifyStaleness,
  ABC_MINIMUM_ITEMS,
} from "./analytics.js";

const D = (n: number | string) => new Prisma.Decimal(n);

describe("inventory turnover", () => {
  /** A period whose sales all carry a recorded cost. */
  const priced = (o: {
    cogs: number;
    openingValue: number;
    closingValue: number;
    periodDays: number;
  }) =>
    inventoryTurnover({
      cogs: D(o.cogs),
      openingValue: D(o.openingValue),
      closingValue: D(o.closingValue),
      periodDays: o.periodDays,
      salesCount: 10,
      salesMissingCost: 0,
      heldStock: true,
    });

  it("divides COGS by the AVERAGE of opening and closing stock", async () => {
    // 100,000 of cost against an average of 25,000 → turned over 4 times.
    const t = priced({
      cogs: 100000,
      openingValue: 30000,
      closingValue: 20000,
      periodDays: 365,
    });
    expect(t.averageValue).toBe(25000);
    expect(t.ratio).toBe(4);
  });

  it("uses the average, not the closing value — the whole point", async () => {
    // A shop that ran its stock down would report a spectacular ratio if the
    // denominator were today's value. Same COGS, same average, wildly
    // different closing figures: the ratio must not move.
    const steady = priced({
      cogs: 100000,
      openingValue: 25000,
      closingValue: 25000,
      periodDays: 365,
    });
    const rundown = priced({
      cogs: 100000,
      openingValue: 49000,
      closingValue: 1000,
      periodDays: 365,
    });
    expect(steady.ratio).toBe(rundown.ratio); // both average 25,000
  });

  it("reports days of inventory, which people can actually act on", async () => {
    // "Turnover 4.2" means little; "you hold 87 days of stock" is immediately
    // either fine or alarming.
    const t = priced({
      cogs: 100000,
      openingValue: 25000,
      closingValue: 25000,
      periodDays: 365,
    });
    expect(t.daysOfInventory).toBe(91); // 365 / 4
  });

  it("returns null, not zero, when there was no stock at all", async () => {
    // Zero would read as "nothing sold", which is a different claim — and a
    // damning one. Undefined is the honest answer.
    const t = inventoryTurnover({
      cogs: D(0),
      openingValue: D(0),
      closingValue: D(0),
      periodDays: 30,
      salesCount: 0,
      salesMissingCost: 0,
      heldStock: false,
    });
    expect(t.ratio).toBeNull();
    expect(t.daysOfInventory).toBeNull();
    expect(t.unavailableReason).toMatch(/no stock/i);
  });

  it("will not call a full warehouse empty just because it isn't priced", async () => {
    // Same zero stock VALUE as the test above, opposite fact. Legacy stock
    // sits on the shelf with no recorded cost, so it is worth nothing as far
    // as the arithmetic can see — and "no stock was held" is then a plain
    // falsehood about a warehouse you could walk into.
    //
    // `heldStock` exists solely to tell these two apart. Without it the branch
    // has to guess, and it guesses wrong for every company that has not run
    // the cost backfill.
    const t = inventoryTurnover({
      cogs: D(0),
      openingValue: D(0),
      closingValue: D(0),
      periodDays: 30,
      salesCount: 0,
      salesMissingCost: 0,
      heldStock: true,
    });
    expect(t.ratio).toBeNull();
    expect(t.unavailableReason).toMatch(/recorded cost/i);
    expect(t.unavailableReason).not.toMatch(/no stock was held/i);
  });

  it("handles a period with stock but no sales", async () => {
    const t = inventoryTurnover({
      cogs: D(0),
      openingValue: D(50000),
      closingValue: D(50000),
      periodDays: 30,
      salesCount: 0,
      salesMissingCost: 0,
      heldStock: true,
    });
    expect(t.ratio).toBe(0); // genuinely zero: stock held, nothing sold
    expect(t.daysOfInventory).toBeNull(); // "never" isn't a number of days
    expect(t.unavailableReason).toBeNull(); // zero IS the answer here
  });

  it("will NOT report 0x when sales happened but their cost is unknown", async () => {
    // THE BUG THIS EXISTS FOR.
    //
    // Stock bought before weighted-average costing shipped has no cost
    // history, and backfill-costs.ts refuses to invent one for a completed
    // sale. COGS therefore comes out at zero for real sales — and "turned
    // over 0 times" is then a confident claim that the stock never moved,
    // printed directly above a chart showing that it did.
    const t = inventoryTurnover({
      cogs: D(0),
      openingValue: D(0),
      closingValue: D(8520058),
      periodDays: 93,
      salesCount: 129,
      salesMissingCost: 129,
      heldStock: true,
    });
    expect(t.ratio).toBeNull(); // NOT 0
    expect(t.unavailableReason).toMatch(/cost/i);
    expect(t.unavailableReason).toContain("129");
  });

  it("distinguishes 'nothing sold' from 'cost not recorded'", async () => {
    // Both produce a COGS of zero and are completely different facts. The sale
    // count is the only thing that separates them, which is why it has to be
    // an input rather than something inferred downstream.
    const nothingSold = inventoryTurnover({
      cogs: D(0),
      openingValue: D(50000),
      closingValue: D(50000),
      periodDays: 30,
      salesCount: 0,
      salesMissingCost: 0,
      heldStock: true,
    });
    const costUnknown = inventoryTurnover({
      cogs: D(0),
      openingValue: D(50000),
      closingValue: D(50000),
      periodDays: 30,
      salesCount: 40,
      salesMissingCost: 40,
      heldStock: true,
    });
    expect(nothingSold.ratio).toBe(0);
    expect(costUnknown.ratio).toBeNull();
  });

  it("still computes a ratio when only SOME sales lack a cost", async () => {
    // Partial history shouldn't throw away a usable answer — but the caller is
    // told how much is missing, so it can say the figure is understated.
    const t = inventoryTurnover({
      cogs: D(50000),
      openingValue: D(25000),
      closingValue: D(25000),
      periodDays: 365,
      salesCount: 100,
      salesMissingCost: 40,
      heldStock: true,
    });
    expect(t.ratio).toBe(2);
    expect(t.salesMissingCost).toBe(40);
    expect(t.unavailableReason).toBeNull();
  });
});

describe("ABC analysis", () => {
  const many = (n: number, valueFor: (i: number) => number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      label: `Product ${i}`,
      value: valueFor(i),
    }));

  it("bands by CUMULATIVE share, not by each item's own share", async () => {
    // The Pareto question is "how much of the total do these together carry?",
    // not "is this one item big?".
    const { rows, classified } = abcAnalysis(
      many(20, (i) => (i === 0 ? 800 : 10))
    );
    expect(classified).toBe(true);
    expect(rows[0]!.class).toBe("A"); // 800 of ~990 on its own
    expect(rows[0]!.cumulativeShare).toBeGreaterThan(75);
  });

  it("always has an A — a dominant product is not a B", async () => {
    // The boundary case that banding on the running total gets wrong. One
    // product at 81% of revenue: if you ask "is the total after this item
    // under 80?" the answer is no, and the most important line in the shop
    // gets filed under B with no A above it.
    const { rows } = abcAnalysis([
      { id: "big", label: "Dominant", value: 810 },
      ...many(19, () => 10),
    ]);
    expect(rows[0]!.class).toBe("A");
    expect(rows.filter((r) => r.class === "A")).toHaveLength(1);
  });

  it("puts the long tail in C", async () => {
    const { rows } = abcAnalysis(many(30, (i) => 100 - i * 3));
    expect(rows[rows.length - 1]!.class).toBe("C");
  });

  it("refuses to classify a tiny catalogue, and says so", async () => {
    // Sorting six products into three bands tells you nothing you couldn't see
    // by looking at six products — and dresses an arbitrary split in the
    // language of analysis.
    const { rows, classified, note } = abcAnalysis(many(6, () => 100));
    expect(classified).toBe(false);
    expect(rows.every((r) => r.class === null)).toBe(true);
    expect(note).toContain(String(ABC_MINIMUM_ITEMS));
    expect(rows).toHaveLength(6); // still ranked — the ranking is useful
  });

  it("ignores products that sold nothing", async () => {
    const { rows } = abcAnalysis([
      ...many(12, () => 100),
      { id: "zero", label: "Never sold", value: 0 },
    ]);
    expect(rows.find((r) => r.id === "zero")).toBeUndefined();
  });

  it("says plainly when there were no sales", async () => {
    const { rows, note } = abcAnalysis([]);
    expect(rows).toHaveLength(0);
    expect(note).toMatch(/no sales/i);
  });
});

describe("trend", () => {
  it("calls a real increase rising", async () => {
    const t = trendOf([10, 10, 10, 20, 20, 20]);
    expect(t.direction).toBe("rising");
    expect(t.changePercent).toBe(100);
  });

  it("calls a real decrease falling", async () => {
    const t = trendOf([20, 20, 20, 10, 10, 10]);
    expect(t.direction).toBe("falling");
  });

  it("calls small wobble STEADY, not a trend", async () => {
    // THE test. 10 → 11 is not 10% growth, it's noise — and calling it growth
    // gets someone to order stock on the strength of one extra sale.
    const t = trendOf([10, 10, 10, 11, 11, 11]);
    expect(t.direction).toBe("steady");
  });

  it("refuses to call a trend from too few points", async () => {
    // Halving a three-point series is not analysis.
    const t = trendOf([1, 5, 2]);
    expect(t.direction).toBe("unknown");
    expect(t.changePercent).toBeNull();
  });

  it("handles growth from nothing without inventing a percentage", async () => {
    // 0 → 10 is not "infinite growth"; there is no percentage to report.
    const t = trendOf([0, 0, 0, 10, 10, 10]);
    expect(t.direction).toBe("rising");
    expect(t.changePercent).toBeNull();
  });

  it("treats a flat line of zeroes as unknown, not steady", async () => {
    // Nothing sold in either half. "Steady" would imply a stable business.
    const t = trendOf([0, 0, 0, 0, 0, 0]);
    expect(t.direction).toBe("unknown");
  });
});

describe("staleness", () => {
  it("calls never-sold stock DEAD, separately from slow", async () => {
    // The remedy differs — slow stock might need a promotion, dead stock
    // probably needs writing off. And dead stock never appears in a sales
    // report BY DEFINITION, so it's the easiest kind to keep paying for.
    expect(
      classifyStaleness({
        onHand: 50,
        daysSinceLastSale: null,
        slowAfterDays: 60,
        staleAfterDays: 120,
      })
    ).toBe("dead");
  });

  it("grades by how long since the last sale", async () => {
    const at = (days: number) =>
      classifyStaleness({
        onHand: 10,
        daysSinceLastSale: days,
        slowAfterDays: 60,
        staleAfterDays: 120,
      });
    expect(at(5)).toBe("moving");
    expect(at(70)).toBe("slow");
    expect(at(200)).toBe("stale");
  });

  it("ignores products with no stock — absent isn't dead", async () => {
    // Reporting these would fill the list with things that cost nothing to
    // hold, burying the ones that do.
    expect(
      classifyStaleness({
        onHand: 0,
        daysSinceLastSale: null,
        slowAfterDays: 60,
        staleAfterDays: 120,
      })
    ).toBeNull();
  });
});
