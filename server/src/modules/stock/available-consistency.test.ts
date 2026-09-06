/**
 * One authoritative "available" (BUG-5 and BUG-6 — the same bug twice).
 *
 * Reported: the Product page shows 100 pcs available while a sale is refused
 * with "only 5 available across batches", and the till can't sell goods the
 * company demonstrably owns.
 *
 * It was never two different formulas. Two TABLES answer the question — the
 * ledger (what we own) and the inventory lots (which lot those units are) —
 * and the lots are a refinement of the ledger, not a second opinion. The gap
 * opens when a product accumulates stock while `tracksBatch` is off and the
 * box is then ticked: every existing unit is real, in the ledger, and in no
 * lot at all.
 *
 * The definition these tests hold everything to:
 *
 *     On hand   = every movement, any condition
 *     Sellable  = movements with status AVAILABLE
 *     Available = Sellable − Reserved
 *     and for batch-tracked products, Available == the sum of eligible lots
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import * as stockService from "./stock.service.js";
import * as productService from "../products/product.service.js";
import * as invService from "../invoices/inv.service.js";
import * as posService from "../pos/pos.service.js";
import { availableQuantity } from "../../lib/reservations.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";

async function shop() {
  const base = await createTestCompany();

  const other = await prisma.location.create({
    data: { companyId: base.company.id, name: "Back office" },
  });

  const put = (quantity: number, opts: { batch?: string; at?: string } = {}) =>
    stockService.createMovement(base.company.id, base.user.id, {
      productId: base.product.id,
      locationId: opts.at ?? base.location.id,
      type: "PURCHASE",
      quantity,
      unitCost: 20,
      ...(opts.batch ? { batchNumber: opts.batch } : {}),
    } as Parameters<typeof stockService.createMovement>[2]);

  /** Turn batch tracking on the way a user does — through the service. */
  const enableBatches = () =>
    productService.updateProduct(
      base.company.id,
      base.product.id,
      { tracksBatch: true } as Parameters<typeof productService.updateProduct>[2],
      base.user.id
    );

  /** The row every stock screen reads. */
  const level = async (locationId = base.location.id) => {
    const rows = await stockService.stockLevels(base.company.id, {
      productId: base.product.id,
    });
    return rows.find((r) => r.location.id === locationId)!;
  };

  const quantities = (locationId = base.location.id) =>
    availableQuantity(prisma, base.company.id, {
      productId: base.product.id,
      locationId,
    });

  const sell = (quantity: number, locationId = base.location.id) =>
    posService.posSale(base.company.id, base.user.id, {
      locationId,
      lines: [{ productId: base.product.id, quantity }],
    } as Parameters<typeof posService.posSale>[2]);

  /** A draft invoice, which RESERVES its lines without moving stock. */
  const reserve = (quantity: number) =>
    invService.createInvoice(base.company.id, base.user.id, {
      customerName: "Holder",
      locationId: base.location.id,
      lines: [{ productId: base.product.id, quantity, unitPrice: 100 }],
    } as Parameters<typeof invService.createInvoice>[2]);

  return { ...base, other, put, enableBatches, level, quantities, sell, reserve };
}

describe("available quantity — one definition", () => {
  beforeEach(resetDb);

  it("normal stock: on hand, sellable and available agree", async () => {
    const { put, level, quantities } = await shop();
    await put(100);

    const q = await quantities();
    expect(Number(q.onHand)).toBe(100);
    expect(Number(q.sellable)).toBe(100);
    expect(Number(q.reserved)).toBe(0);
    expect(Number(q.available)).toBe(100);

    const row = await level();
    expect(Number(row.quantity)).toBe(100);
    expect(Number(row.available)).toBe(100);
    expect(row.batchAvailable).toBeNull(); // not batch-tracked
  });

  it("reserved stock is present but not available", async () => {
    const { put, level, quantities, reserve } = await shop();
    await put(100);
    await reserve(30);

    const q = await quantities();
    expect(Number(q.onHand)).toBe(100);
    expect(Number(q.reserved)).toBe(30);
    expect(Number(q.available)).toBe(70);
    expect(Number((await level()).available)).toBe(70);
  });

  it("damaged and quarantined stock is owned but never available", async () => {
    const { company, user, product, location, put, level } = await shop();
    await put(100);
    const reclassify = (quantity: number, status: "DAMAGED" | "QUARANTINE") =>
      stockService.createMovement(company.id, user.id, {
        productId: product.id,
        locationId: location.id,
        type: "ADJUSTMENT",
        quantity: -quantity,
        status: "AVAILABLE",
      } as Parameters<typeof stockService.createMovement>[2]).then(() =>
        stockService.createMovement(company.id, user.id, {
          productId: product.id,
          locationId: location.id,
          type: "ADJUSTMENT",
          quantity,
          status,
        } as Parameters<typeof stockService.createMovement>[2])
      );

    await reclassify(10, "DAMAGED");
    await reclassify(5, "QUARANTINE");

    const row = await level();
    expect(Number(row.quantity)).toBe(100); // still owned
    expect(Number(row.damaged)).toBe(10);
    expect(Number(row.quarantine)).toBe(5);
    expect(Number(row.available)).toBe(85); // only sellable stock counts
  });

  it("stock is per location, never pooled", async () => {
    const { other, put, level } = await shop();
    await put(100);
    await put(7, { at: other.id });

    expect(Number((await level()).available)).toBe(100);
    expect(Number((await level(other.id)).available)).toBe(7);
  });
});

describe("batch-tracked availability — the ledger and the lots agree", () => {
  beforeEach(resetDb);

  it("THE BUG: enabling batch tracking on existing stock covers it", async () => {
    // 95 units bought before anyone ticked the box, 5 received after with a
    // real lot number. Before the fix: page 100, till 5.
    const { put, enableBatches, level, sell } = await shop();
    await put(95);

    await enableBatches();
    await put(5, { batch: "B-NEW" });

    const row = await level();
    expect(Number(row.available)).toBe(100);
    // The lots now account for every sellable unit — no second opinion.
    expect(Number(row.batchAvailable)).toBe(100);

    // And the sale that used to fail now goes through.
    const sale = await sell(10);
    expect(sale.invoice.status).not.toBe("DRAFT");
    expect(Number((await level()).available)).toBe(90);
  });

  it("the opening batch is consumed after lots with a known expiry", async () => {
    // FEFO with a null expiry sorts LAST — legacy stock of unknown age must
    // not jump ahead of stock we know expires next week.
    const { company, user, product, location, put, enableBatches, sell } =
      await shop();
    await put(10); // legacy, no lot
    await enableBatches();

    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "PURCHASE",
      quantity: 10,
      unitCost: 20,
      batchNumber: "SOON",
      expiryDate: new Date("2026-10-01").toISOString(),
    } as Parameters<typeof stockService.createMovement>[2]);

    await sell(4);

    const lots = await prisma.inventoryBatch.findMany({
      where: { companyId: company.id, productId: product.id },
      orderBy: { batchNumber: "asc" },
    });
    const byNumber = Object.fromEntries(
      lots.map((l) => [l.batchNumber, Number(l.remainingQuantity)])
    );
    expect(byNumber["SOON"]).toBe(6); // the dated lot went first
    expect(byNumber["OPENING"]).toBe(10); // legacy stock untouched
  });

  it("a sale spanning multiple batches allocates across them", async () => {
    const { company, product, put, enableBatches, sell, level } = await shop();
    await enableBatches();
    await put(4, { batch: "A" });
    await put(4, { batch: "B" });
    await put(4, { batch: "C" });

    expect(Number((await level()).batchAvailable)).toBe(12);

    await sell(10); // more than any single lot holds

    const remaining = await prisma.inventoryBatch.aggregate({
      where: { companyId: company.id, productId: product.id },
      _sum: { remainingQuantity: true },
    });
    expect(Number(remaining._sum.remainingQuantity)).toBe(2);
    const row = await level();
    expect(Number(row.available)).toBe(2);
    expect(Number(row.batchAvailable)).toBe(2);
  });

  it("selling EXACTLY the available quantity succeeds", async () => {
    const { put, enableBatches, sell, level } = await shop();
    await enableBatches();
    await put(6, { batch: "A" });
    await put(4, { batch: "B" });

    await sell(10);
    const row = await level();
    expect(Number(row.available)).toBe(0);
    expect(Number(row.batchAvailable)).toBe(0);
  });

  it("selling MORE than available is refused, with the real number", async () => {
    const { put, enableBatches, sell } = await shop();
    await enableBatches();
    await put(6, { batch: "A" });

    await expect(sell(7)).rejects.toThrow(/only 6|Not enough stock/i);
  });

  it("reserved stock is not available to a POS sale", async () => {
    const { put, enableBatches, reserve, sell, level } = await shop();
    await enableBatches();
    await put(10, { batch: "A" });
    await reserve(8); // a draft invoice holds 8

    expect(Number((await level()).available)).toBe(2);
    await expect(sell(5)).rejects.toThrow(/Not enough stock/i);

    // ...but the 2 that are genuinely free still sell.
    await sell(2);
    expect(Number((await level()).available)).toBe(0);
  });

  it("damaged lots are never picked for a sale", async () => {
    const { company, user, product, location, put, enableBatches, sell } =
      await shop();
    await enableBatches();
    await put(10, { batch: "GOOD" });

    // 6 of them turn out to be broken.
    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "ADJUSTMENT",
      quantity: -6,
      status: "AVAILABLE",
    } as Parameters<typeof stockService.createMovement>[2]);
    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "ADJUSTMENT",
      quantity: 6,
      status: "DAMAGED",
      batchNumber: "GOOD",
    } as Parameters<typeof stockService.createMovement>[2]);

    await expect(sell(6)).rejects.toThrow(/Not enough stock/i);
    await sell(4); // the sound units still sell
  });

  it("a POS sale and an ordinary invoice reach the same stock position", async () => {
    // Same guard, same allocation, same ledger — POS is the ordinary path
    // with a till attached, not a second way to move stock.
    const { company, user, product, location, put, enableBatches, sell, level } =
      await shop();
    await enableBatches();
    await put(20, { batch: "A" });

    await sell(5);
    const afterPos = Number((await level()).available);

    const draft = await invService.createInvoice(company.id, user.id, {
      customerName: "Counter",
      locationId: location.id,
      lines: [{ productId: product.id, quantity: 5, unitPrice: 100 }],
    } as Parameters<typeof invService.createInvoice>[2]);
    await invService.issueInvoice(company.id, user.id, draft.id);

    const afterInvoice = Number((await level()).available);
    expect(afterPos).toBe(15);
    expect(afterInvoice).toBe(10);

    const row = await level();
    expect(Number(row.batchAvailable)).toBe(Number(row.available));
  });

  it("batch coverage is per location", async () => {
    const { other, put, enableBatches, level } = await shop();
    await put(30);
    await put(12, { at: other.id });
    await enableBatches();

    expect(Number((await level()).batchAvailable)).toBe(30);
    expect(Number((await level(other.id)).batchAvailable)).toBe(12);
  });
});
