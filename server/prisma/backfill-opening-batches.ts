/**
 * One-off repair: give legacy stock a batch.
 *
 * WHY THIS SCRIPT EXISTS
 *
 * Products that were switched to batch tracking BEFORE the fix in
 * product.service.ts kept whatever stock they already had, with none of it
 * assigned to a lot. The ledger says 100, the lots hold 5, and a sale is
 * refused for goods the company owns.
 *
 * The code fix stops this happening again. It cannot repair data that is
 * already in that state, because nothing will touch those products again
 * until someone tries to sell them — which is exactly when it hurts.
 *
 * WHAT IT DOES
 *
 * For every batch-tracked, active product, at every location: compare the
 * ledger's sellable quantity with the sum of AVAILABLE lots, and place any
 * uncovered remainder in an OPENING batch. The quantity always comes from the
 * ledger, so this can only bring the lots UP TO what is already recorded —
 * it can never create stock.
 *
 *   npx tsx prisma/backfill-opening-batches.ts            # report only
 *   npx tsx prisma/backfill-opening-batches.ts --apply    # write
 *
 * Safe to run twice: a second run finds nothing left to cover.
 */
import { prisma } from "../src/lib/prisma.js";
import { lockStock, LOCKED_TX_OPTIONS } from "../src/lib/locks.js";
import { ensureBatchCoverage } from "../src/modules/stock/batch.service.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  const products = await prisma.product.findMany({
    where: { tracksBatch: true, isActive: true },
    select: { id: true, sku: true, name: true, companyId: true, avgCost: true },
  });

  let gaps = 0;

  for (const product of products) {
    const locations = await prisma.location.findMany({
      where: { companyId: product.companyId },
      select: { id: true, name: true },
    });

    for (const location of locations) {
      const [ledger, batched] = await Promise.all([
        prisma.stockMovement.aggregate({
          where: {
            companyId: product.companyId,
            productId: product.id,
            locationId: location.id,
            status: "AVAILABLE",
          },
          _sum: { quantity: true },
        }),
        prisma.inventoryBatch.aggregate({
          where: {
            companyId: product.companyId,
            productId: product.id,
            locationId: location.id,
            status: "AVAILABLE",
          },
          _sum: { remainingQuantity: true },
        }),
      ]);

      const onHand = Number(ledger._sum.quantity ?? 0);
      const covered = Number(batched._sum.remainingQuantity ?? 0);
      const shortfall = onHand - covered;
      if (onHand <= 0 || shortfall <= 0) continue;

      gaps += 1;
      console.log(
        `${product.sku} @ ${location.name}: ledger ${onHand}, batches ${covered}` +
          ` → ${shortfall} unassigned`
      );

      if (!APPLY) continue;

      await prisma.$transaction(async (tx) => {
        await lockStock(tx, product.companyId, [
          { productId: product.id, locationId: location.id },
        ]);
        const opened = await ensureBatchCoverage(
          tx,
          product.companyId,
          product.id,
          location.id,
          product.avgCost
        );
        await tx.auditLog.create({
          data: {
            companyId: product.companyId,
            userId: null,
            action: "batch.opening",
            entity: "product",
            entityId: product.id,
            summary:
              `${product.name} (${product.sku}) @ ${location.name}: ` +
              `${opened.toString()} units placed in an OPENING batch by ` +
              `backfill-opening-batches`,
          },
        });
      }, LOCKED_TX_OPTIONS);
    }
  }

  if (gaps === 0) {
    console.log("Nothing to do — every batch-tracked product is fully covered.");
  } else if (!APPLY) {
    console.log(`\n${gaps} shelf/shelves need an opening batch. Re-run with --apply.`);
  } else {
    console.log(`\nCovered ${gaps} shelf/shelves.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
