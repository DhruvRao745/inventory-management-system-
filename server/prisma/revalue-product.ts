/**
 * Correct a product's weighted-average cost — as a recorded event.
 *
 * WHEN THIS IS NEEDED
 *
 * A purchase recorded at the wrong unit cost. The usual version is the selling
 * price typed into the cost field, which leaves inventory overvalued and every
 * margin on that product reading as zero or negative.
 *
 * WHY THE MOVEMENTS ARE NOT EDITED
 *
 * `StockMovement.unitCost` records what was ENTERED on that date. That remains
 * a true fact even though the figure was a mistake, and rewriting it would
 * destroy the evidence that an error ever happened — the same reason
 * `costAtTime` is never touched (PRD §7).
 *
 * `avgCost` and `stockValue` are different in kind: maintained current state,
 * not ledger rows. Correcting them is legitimate, in the same way a stocktake
 * corrects quantity without rewriting the movements that preceded it.
 *
 * WHY IT IS LOGGED
 *
 * A valuation that changes with no name and no reason attached is
 * indistinguishable from tampering. The correction is written to the audit log
 * with before/after values, so "why is this product worth less than last
 * week?" has an answer.
 *
 * NOTE ON RE-RUNNING backfill-costs.ts
 *
 * That script only touches products whose `avgCost` is zero, so it will not
 * undo this. But it computes from the movement rows, which still carry the
 * wrong figure — so if this product's average is ever reset to zero, it will
 * be recomputed wrongly again. The audit entry is what tells the next person
 * why the two disagree.
 *
 * USAGE
 *
 *   npx tsx prisma/revalue-product.ts --sku PHN --cost 50000 --reason "..."
 *   npx tsx prisma/revalue-product.ts --sku PHN --cost 50000 --reason "..." --apply
 */
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const D = Prisma.Decimal;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const SKU = arg("sku");
const COST = arg("cost");
const REASON = arg("reason") ?? "Unit cost corrected";
const APPLY = process.argv.includes("--apply");

async function main() {
  if (!SKU || !COST) {
    console.error(
      "Usage: --sku <SKU> --cost <newUnitCost> [--reason <text>] [--apply]"
    );
    process.exit(1);
  }

  const newCost = new D(COST);
  if (newCost.lessThan(0)) {
    console.error("Cost cannot be negative.");
    process.exit(1);
  }

  const products = await prisma.product.findMany({
    where: { sku: SKU },
    select: {
      id: true,
      companyId: true,
      sku: true,
      name: true,
      unit: true,
      avgCost: true,
      stockValue: true,
      costPrice: true,
      company: { select: { name: true } },
    },
  });

  if (products.length === 0) {
    console.error(`No product with SKU "${SKU}".`);
    process.exit(1);
  }

  console.log(
    APPLY ? "APPLYING revaluation\n" : "DRY RUN — nothing will be written.\n"
  );

  for (const p of products) {
    // On hand from the ledger, never a stored counter.
    const agg = await prisma.stockMovement.aggregate({
      where: { companyId: p.companyId, productId: p.id },
      _sum: { quantity: true },
    });
    const onHand = agg._sum.quantity ?? new D(0);
    const newValue = onHand.times(newCost).toDecimalPlaces(4);

    console.log(`${p.company.name} — ${p.sku} ${p.name}`);
    console.log(`  on hand      ${onHand.toString()} ${p.unit}`);
    console.log(
      `  avg cost     ${p.avgCost.toString()}  →  ${newCost.toString()}`
    );
    console.log(
      `  stock value  ${p.stockValue.toString()}  →  ${newValue.toString()}`
    );
    console.log(
      `  difference   ${newValue.minus(p.stockValue).toString()}\n`
    );

    if (!APPLY) continue;

    // Product update and audit entry commit together, or neither does — the
    // same rule every other write in this system follows. A valuation change
    // with no surviving explanation is worse than no change at all.
    await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: p.id },
        data: { avgCost: newCost, stockValue: newValue },
      });

      await tx.auditLog.create({
        data: {
          companyId: p.companyId,
          userId: null, // run from the command line, not by a signed-in user
          actorEmail: "script:revalue-product",
          action: "stock.revalue",
          entity: "product",
          entityId: p.id,
          summary: `${p.name} (${p.sku}) revalued: ${p.avgCost.toString()} → ${newCost.toString()} per ${p.unit}. ${REASON}`,
          before: {
            avgCost: p.avgCost.toString(),
            stockValue: p.stockValue.toString(),
          },
          after: {
            avgCost: newCost.toString(),
            stockValue: newValue.toString(),
            onHand: onHand.toString(),
            reason: REASON,
          },
        },
      });
    });

    console.log("  ✓ applied and logged\n");
  }

  if (!APPLY) {
    console.log("Re-run with --apply to write.");
  }
  console.log(
    "Movement rows are unchanged — they record what was entered at the time,\n" +
      "which stays true even though the figure was wrong."
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
