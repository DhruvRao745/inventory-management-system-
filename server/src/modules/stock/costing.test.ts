/**
 * Weighted-average costing + COGS (P1-3).
 *
 * The rule that matters most (PRD §7):
 *
 *   "The historical cost used for a completed sale must not change simply
 *    because a later purchase changes the average cost."
 *
 * That's what separates an accounting system from a spreadsheet that rewrites
 * its own past. Several tests below exist purely to defend it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import * as stockService from "./stock.service.js";
import * as invService from "../invoices/inv.service.js";
import { cogsForPeriod, grossProfit } from "../../lib/costing.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";

const D = (v: string | number) => new Prisma.Decimal(v);

async function costSetup() {
  const base = await createTestCompany();

  const buy = (quantity: number, unitCost: number) =>
    stockService.createMovement(base.company.id, base.user.id, {
      productId: base.product.id,
      locationId: base.location.id,
      type: "PURCHASE",
      quantity,
      unitCost,
    } as Parameters<typeof stockService.createMovement>[2]);

  const sell = (quantity: number) =>
    stockService.createMovement(base.company.id, base.user.id, {
      productId: base.product.id,
      locationId: base.location.id,
      type: "SALE",
      quantity,
    } as Parameters<typeof stockService.createMovement>[2]);

  const state = async () => {
    const p = await prisma.product.findUnique({
      where: { id: base.product.id },
      select: { avgCost: true, stockValue: true },
    });
    return {
      avgCost: p!.avgCost.toString(),
      stockValue: p!.stockValue.toString(),
    };
  };

  return { ...base, buy, sell, state };
}

describe("weighted average — the arithmetic", () => {
  beforeEach(resetDb);

  it("PRD formula: 10 @ 100 then 10 @ 120 → average 110", async () => {
    const { buy, state } = await costSetup();
    await buy(10, 100);
    await buy(10, 120);

    // 2200 total value over 20 units
    const s = await state();
    expect(s.avgCost).toBe("110");
    expect(s.stockValue).toBe("2200");
  });

  it("selling does NOT move the average", async () => {
    // Selling removes value at the current average; it doesn't re-price
    // what's still on the shelf.
    const { buy, sell, state } = await costSetup();
    await buy(10, 100);
    await buy(10, 120);
    await sell(5);

    const s = await state();
    expect(s.avgCost).toBe("110"); // unchanged
    expect(s.stockValue).toBe("1650"); // 2200 − (5 × 110)
  });

  it("a first purchase sets the average outright", async () => {
    const { buy, state } = await costSetup();
    await buy(4, 25);
    expect(await state()).toEqual({ avgCost: "25", stockValue: "100" });
  });

  it("keeps six decimal places where money keeps two", async () => {
    // ₹100 over 3 units is 33.333333… Rounding that to paise on every
    // receipt would compound into visible drift.
    const { buy, state } = await costSetup();
    await buy(3, 33.333333);
    const s = await state();
    expect(s.avgCost).toBe("33.333333");
  });

  it("value never goes negative", async () => {
    const { buy, sell, state } = await costSetup();
    await buy(10, 10);
    await sell(10);
    const s = await state();
    expect(Number(s.stockValue)).toBe(0);
    expect(Number(s.stockValue)).toBeGreaterThanOrEqual(0);
  });
});

describe("COGS — history must not be rewritten", () => {
  beforeEach(resetDb);

  it("a sale keeps its cost after a later, dearer purchase", async () => {
    // THE test for PRD §7. Buy cheap, sell, then buy dear. The completed
    // sale's cost must not move.
    const { company, buy, sell } = await costSetup();
    await buy(10, 100);
    const sale = await sell(5); // at avg 100

    await buy(10, 200); // average is now 150 for what remains

    const fresh = await prisma.stockMovement.findUnique({
      where: { id: sale.id },
      select: { costAtTime: true },
    });
    expect(fresh!.costAtTime!.toString()).toBe("100"); // NOT 150

    const { cogs } = await cogsForPeriod(
      prisma,
      company.id,
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000)
    );
    expect(cogs.toString()).toBe("500"); // 5 × 100, forever
  });

  it("COGS across two different average costs sums correctly", async () => {
    const { company, buy, sell } = await costSetup();
    await buy(10, 100);
    await sell(5); // 5 × 100 = 500
    await buy(10, 200); // 15 units: (500 + 2000) / 15 = 166.666667
    await sell(5); // 5 × 166.666667 = 833.333335

    const { cogs, unitsSold } = await cogsForPeriod(
      prisma,
      company.id,
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000)
    );
    expect(Number(unitsSold)).toBe(10);
    expect(Number(cogs)).toBeCloseTo(1333.33, 1);
  });

  it("stamps the cost on invoice sales too", async () => {
    const { company, user, location, product, buy } = await costSetup();
    await buy(10, 40);

    const inv = await invService.createInvoice(company.id, user.id, {
      customerName: "Walk-in",
      locationId: location.id,
      lines: [{ productId: product.id, quantity: 3, unitPrice: 60 }],
    } as Parameters<typeof invService.createInvoice>[2]);
    await invService.issueInvoice(company.id, user.id, inv.id);

    const move = await prisma.stockMovement.findFirst({
      where: { companyId: company.id, type: "SALE" },
    });
    expect(move!.costAtTime!.toString()).toBe("40");
  });
});

describe("gross profit", () => {
  beforeEach(resetDb);

  it("revenue − COGS, with margin as a percentage", () => {
    const { profit, margin } = grossProfit(D(1000), D(600));
    expect(profit.toString()).toBe("400");
    expect(margin.toString()).toBe("40");
  });

  it("reports zero margin rather than dividing by zero revenue", () => {
    const { profit, margin } = grossProfit(D(0), D(0));
    expect(profit.toString()).toBe("0");
    expect(margin.toString()).toBe("0");
  });

  it("a real sale produces an honest margin", async () => {
    // Bought at 40, sold at 60 → profit 20/unit, margin 33.33%.
    const { company, user, location, product, buy } = await costSetup();
    await buy(10, 40);
    const inv = await invService.createInvoice(company.id, user.id, {
      customerName: "Walk-in",
      locationId: location.id,
      lines: [{ productId: product.id, quantity: 5, unitPrice: 60 }],
    } as Parameters<typeof invService.createInvoice>[2]);
    await invService.issueInvoice(company.id, user.id, inv.id);

    const { cogs } = await cogsForPeriod(
      prisma,
      company.id,
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000)
    );
    const { profit, margin } = grossProfit(D(300), cogs); // 5 × 60 revenue
    expect(cogs.toString()).toBe("200");
    expect(profit.toString()).toBe("100");
    expect(Number(margin)).toBeCloseTo(33.33, 1);
  });
});

describe("costing — returns and adjustments", () => {
  beforeEach(resetDb);

  it("cancelling a sale restores the ORIGINAL cost, not today's average", async () => {
    // Otherwise undoing a sale would conjure profit: the books would gain
    // value from nothing having happened.
    const { company, user, location, product, buy, state } = await costSetup();
    await buy(10, 100);

    const inv = await invService.createInvoice(company.id, user.id, {
      customerName: "Walk-in",
      locationId: location.id,
      lines: [{ productId: product.id, quantity: 5, unitPrice: 150 }],
    } as Parameters<typeof invService.createInvoice>[2]);
    await invService.issueInvoice(company.id, user.id, inv.id);
    expect((await state()).stockValue).toBe("500"); // 5 left × 100

    await buy(10, 200); // average moves for the survivors
    await invService.cancelInvoice(company.id, user.id, inv.id);

    // The 5 returned units come back at 100 (what they left at), NOT at the
    // post-purchase average.
    const returned = await prisma.stockMovement.findFirst({
      where: { companyId: company.id, type: "RETURN_IN" },
    });
    expect(returned!.costAtTime!.toString()).toBe("100");
  });

  it("an adjustment is valued at the current average", async () => {
    const { buy, company, user, location, product, state } = await costSetup();
    await buy(10, 50);

    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "ADJUSTMENT",
      quantity: -2, // two broken
    } as Parameters<typeof stockService.createMovement>[2]);

    // 500 − (2 × 50) = 400
    expect((await state()).stockValue).toBe("400");
  });

  it("a transfer does not change cost at all", async () => {
    // Moving your own stock between your own shelves cost you nothing.
    const { company, user, location, product, buy, state } = await costSetup();
    await buy(10, 75);
    const before = await state();

    const dest = await prisma.location.create({
      data: { companyId: company.id, name: "Godown" },
    });
    await stockService.transfer(company.id, user.id, {
      productId: product.id,
      fromLocationId: location.id,
      toLocationId: dest.id,
      quantity: 4,
    } as Parameters<typeof stockService.transfer>[2]);

    expect(await state()).toEqual(before);
  });
});

describe("costing — concurrency (needs the company-wide cost lock)", () => {
  beforeEach(resetDb);

  it("simultaneous receipts at DIFFERENT locations don't lose an update", async () => {
    // This is precisely what lockStock does NOT cover: two different
    // locations take two different stock locks and sail past each other,
    // then both read-modify-write the same company-wide Product.avgCost.
    const { company, user, location, product } = await costSetup();
    const other = await prisma.location.create({
      data: { companyId: company.id, name: "Godown" },
    });

    await Promise.all([
      stockService.createMovement(company.id, user.id, {
        productId: product.id,
        locationId: location.id,
        type: "PURCHASE",
        quantity: 10,
        unitCost: 100,
      } as Parameters<typeof stockService.createMovement>[2]),
      stockService.createMovement(company.id, user.id, {
        productId: product.id,
        locationId: other.id,
        type: "PURCHASE",
        quantity: 10,
        unitCost: 200,
      } as Parameters<typeof stockService.createMovement>[2]),
    ]);

    const p = await prisma.product.findUnique({
      where: { id: product.id },
      select: { avgCost: true, stockValue: true },
    });
    // Both receipts must be reflected: 3000 over 20 units = 150.
    // A lost update would leave 1000 or 2000 here.
    expect(Number(p!.stockValue)).toBe(3000);
    expect(Number(p!.avgCost)).toBe(150);
  });
});
