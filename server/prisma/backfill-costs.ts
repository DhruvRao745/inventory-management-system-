/**
 * One-off: give legacy stock an opening cost.
 *
 * THE PROBLEM
 *
 * `Product.avgCost` and `Product.stockValue` are maintained by lib/costing.ts,
 * which only started running when P1-3 shipped. Stock received before that
 * contributed nothing to either, so a company can hold 1,358 units and report
 * a stock value of ₹0 — and every figure built on it (valuation, gross profit,
 * dashboard COGS) is zero with it.
 *
 * Nothing is broken. The costing engine is correct and needs no change; it
 * simply has no history to work from. This script supplies the opening
 * balance it never got.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not touch `costAtTime` on past movements.
 *
 * Backfilling those would make historical COGS non-zero, which LOOKS like a
 * fix and is the wrong thing to do. PRD §7: "The historical cost used for a
 * completed sale must not change." Those rows are append-only, and we do not
 * know what those sales actually cost — stamping a plausible number on a
 * completed sale converts "we don't know" into "we are confident, and wrong",
 * which is worse than a zero anyone can see and question.
 *
 * So: past periods keep reporting what they recorded. From here on, costing
 * works normally.
 *
 * WHERE THE NUMBER COMES FROM, best source first
 *
 *   1. REPLAY — the weighted average of every incoming movement that carries a
 *      `unitCost`. This is real data, not an estimate. It is also exactly
 *      right: the average only moves when stock comes IN (selling removes
 *      value at the current average, it doesn't re-price what's left), so the
 *      weighted average of all purchases IS the current average.
 *
 *   2. costPrice — the reference figure someone typed on the product. Used
 *      only when no incoming movement has a cost at all. This is an opening
 *      balance, not a measurement, and the script says so per product.
 *
 * A product with no stock, or one that already has an average, is left alone.
 *
 * USAGE
 *
 *   npx tsx prisma/backfill-costs.ts             # dry run — reports, writes nothing
 *   npx tsx prisma/backfill-costs.ts --apply     # actually writes
 *
 * Dry run is the default on purpose. A script that writes to a production
 * database on its first invocation is one keystroke away from an accident.
 */
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const D = Prisma.Decimal;

const APPLY = process.argv.includes("--apply");

/** Movements that ADD stock. The average only ever changes on these. */
const INCOMING = ["PURCHASE", "RETURN_IN", "TRANSFER_IN"] as const;

type Plan = {
  productId: string;
  sku: string;
  name: string;
  onHand: Prisma.Decimal;
  avgCost: Prisma.Decimal;
  stockValue: Prisma.Decimal;
  source: "replay" | "costPrice" | "none";
  /** How many incoming movements had a usable cost, for the report. */
  pricedMovements: number;
};

async function planForCompany(companyId: string): Promise<Plan[]> {
  const products = await prisma.product.findMany({
    where: { companyId },
    select: {
      id: true,
      sku: true,
      name: true,
      costPrice: true,
      avgCost: true,
      stockValue: true,
    },
  });

  // Current stock per product, from the ledger — never a stored counter.
  const grouped = await prisma.stockMovement.groupBy({
    by: ["productId"],
    where: { companyId },
    _sum: { quantity: true },
  });
  const onHandById = new Map(
    grouped.map((g) => [g.productId, g._sum.quantity ?? new D(0)])
  );

  const plans: Plan[] = [];

  for (const p of products) {
    const onHand = onHandById.get(p.id) ?? new D(0);

    // Nothing on the shelf, or the average is already established — leave it.
    // Overwriting a correct average with an estimate would be a downgrade.
    if (onHand.lessThanOrEqualTo(0)) continue;
    if (p.avgCost.greaterThan(0)) continue;

    // --- source 1: replay the priced incoming movements ------------------
    const incoming = await prisma.stockMovement.findMany({
      where: {
        companyId,
        productId: p.id,
        type: { in: [...INCOMING] },
        unitCost: { not: null },
      },
      select: { quantity: true, unitCost: true },
    });

    let totalQty = new D(0);
    let totalValue = new D(0);
    for (const m of incoming) {
      const qty = m.quantity.abs();
      if (qty.lessThanOrEqualTo(0)) continue;
      totalQty = totalQty.plus(qty);
      totalValue = totalValue.plus(qty.times(m.unitCost!));
    }

    let avgCost: Prisma.Decimal;
    let source: Plan["source"];

    if (totalQty.greaterThan(0) && totalValue.greaterThan(0)) {
      avgCost = totalValue.dividedBy(totalQty).toDecimalPlaces(6);
      source = "replay";
    } else if (p.costPrice.greaterThan(0)) {
      // --- source 2: the typed reference cost, as an opening balance -----
      avgCost = p.costPrice.toDecimalPlaces(6);
      source = "costPrice";
    } else {
      // Nothing to go on. Reported rather than guessed — a made-up cost here
      // would be indistinguishable from a real one later.
      plans.push({
        productId: p.id,
        sku: p.sku,
        name: p.name,
        onHand,
        avgCost: new D(0),
        stockValue: new D(0),
        source: "none",
        pricedMovements: incoming.length,
      });
      continue;
    }

    plans.push({
      productId: p.id,
      sku: p.sku,
      name: p.name,
      onHand,
      avgCost,
      // Kept consistent with what the costing engine maintains:
      // stockValue must equal onHand × avgCost, or valuation reports and the
      // engine's own arithmetic will disagree from the next purchase onwards.
      stockValue: onHand.times(avgCost).toDecimalPlaces(4),
      source,
      pricedMovements: incoming.length,
    });
  }

  return plans;
}

async function main() {
  const companies = await prisma.company.findMany({
    select: { id: true, name: true, currency: true },
  });

  console.log(
    APPLY
      ? "APPLYING opening costs\n"
      : "DRY RUN — nothing will be written. Re-run with --apply to commit.\n"
  );

  let totalWritten = 0;
  let totalUnknown = 0;
  let totalPlanned = 0;

  for (const company of companies) {
    const plans = await planForCompany(company.id);
    if (plans.length === 0) continue;

    console.log(`\n${company.name}`);
    console.log("─".repeat(70));

    for (const plan of plans) {
      const qty = plan.onHand.toString();

      if (plan.source === "none") {
        totalUnknown++;
        console.log(
          `  ⚠ ${plan.sku.padEnd(14)} ${plan.name.padEnd(24)} ` +
            `${qty.padStart(8)} on hand — NO COST AVAILABLE, skipped`
        );
        continue;
      }

      const label =
        plan.source === "replay"
          ? `from ${plan.pricedMovements} priced receipt${plan.pricedMovements === 1 ? "" : "s"}`
          : "from costPrice (opening balance)";

      console.log(
        `  ${plan.sku.padEnd(14)} ${plan.name.padEnd(24)} ` +
          `${qty.padStart(8)} × ${plan.avgCost.toString().padStart(10)} ` +
          `= ${plan.stockValue.toString().padStart(12)}  (${label})`
      );

      totalPlanned++;
      if (APPLY) {
        await prisma.product.update({
          where: { id: plan.productId },
          data: { avgCost: plan.avgCost, stockValue: plan.stockValue },
        });
        totalWritten++;
      }
    }
  }

  console.log("\n" + "═".repeat(70));
  if (APPLY) {
    console.log(`Updated ${totalWritten} product(s).`);
  } else {
    // Counted during the pass above rather than recomputed — planning walks
    // every product's movement history, and doing it twice to print one number
    // would double the work on a large catalogue.
    console.log(
      `Would update ${totalPlanned} product(s). Re-run with --apply to write.`
    );
  }
  if (totalUnknown > 0) {
    console.log(
      `${totalUnknown} product(s) have stock but no cost anywhere — set a cost ` +
        `price on them and re-run, or record a purchase with a unit cost.`
    );
  }
  console.log(
    "\nHistorical COGS is unchanged by design — past sales keep the cost they " +
      "were recorded with (PRD §7)."
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
