/**
 * Purchase automation (P3-1).
 *
 * The rule that shapes everything here: this generates DRAFTS, never orders.
 *
 * That isn't enforced by a check someone could forget — the generator has no
 * way to set any status but DRAFT, because it goes through `createPO()`, which
 * only ever creates drafts. Reaching a supplier still requires a human moving
 * the order to ORDERED, exactly as before.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import * as service from "./reorder.service.js";
import * as stockService from "../stock/stock.service.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";

/** A company with two suppliers and stocked products below their minimums. */
async function shortShop() {
  const base = await createTestCompany();

  // The fixture ships a "Test Widget" with a threshold of 5 and no stock, so
  // it is short at every location and has no supplier — it would appear in
  // `skipped` on every single run and drown out what each test is actually
  // checking. A zero minimum means "don't track this here", which takes it out
  // of the report entirely.
  await prisma.product.update({
    where: { id: base.product.id },
    data: { lowStockThreshold: 0 },
  });

  const acme = await prisma.supplier.create({
    data: { companyId: base.company.id, name: "Acme Supplies" },
  });
  const globex = await prisma.supplier.create({
    data: { companyId: base.company.id, name: "Globex" },
  });

  /** A product with a minimum, a preferred supplier, and some stock. */
  const product = async (
    sku: string,
    supplierId: string | null,
    onHand: number,
    threshold = 10,
    costPrice = 20
  ) => {
    const p = await prisma.product.create({
      data: {
        companyId: base.company.id,
        sku,
        name: `Product ${sku}`,
        costPrice,
        sellingPrice: costPrice * 2,
        lowStockThreshold: threshold,
        preferredSupplierId: supplierId,
      },
    });
    if (onHand > 0) {
      await stockService.createMovement(base.company.id, base.user.id, {
        productId: p.id,
        locationId: base.location.id,
        type: "PURCHASE",
        quantity: onHand,
        unitCost: costPrice,
      } as Parameters<typeof stockService.createMovement>[2]);
    }
    return p;
  };

  return { ...base, acme, globex, product };
}

describe("purchase automation — grouping", () => {
  beforeEach(resetDb);

  it("creates ONE draft order per supplier, not one per product", async () => {
    // A purchase order goes to one supplier; the reorder report spans many.
    // Grouping isn't a convenience here — it's what makes the output valid.
    const shop = await shortShop();
    await shop.product("A-1", shop.acme.id, 2);
    await shop.product("A-2", shop.acme.id, 3);
    await shop.product("G-1", shop.globex.id, 1);

    const { created } = await service.generateDraftPOs(
      shop.company.id,
      shop.user.id
    );

    expect(created).toHaveLength(2);
    const acmeOrder = created.find((c) => c.supplier.id === shop.acme.id)!;
    expect(acmeOrder.lineCount).toBe(2);
    expect(
      created.find((c) => c.supplier.id === shop.globex.id)!.lineCount
    ).toBe(1);
  });

  it("sums a product short at two locations into ONE line", async () => {
    // The report is per shelf because that's how you restock. You order from
    // a supplier once — where the goods go is decided at receiving.
    const shop = await shortShop();
    const p = await shop.product("A-1", shop.acme.id, 2);
    const other = await prisma.location.create({
      data: { companyId: shop.company.id, name: "Godown" },
    });
    await stockService.createMovement(shop.company.id, shop.user.id, {
      productId: p.id,
      locationId: other.id,
      type: "PURCHASE",
      quantity: 1,
      unitCost: 20,
    } as Parameters<typeof stockService.createMovement>[2]);

    const { created } = await service.generateDraftPOs(
      shop.company.id,
      shop.user.id
    );

    expect(created).toHaveLength(1);
    expect(created[0]!.lineCount).toBe(1); // one line, not two

    const po = await prisma.purchaseOrder.findFirstOrThrow({
      include: { lines: true },
    });
    // Both shelves' shortfalls, added together.
    expect(Number(po.lines[0]!.quantity)).toBeGreaterThan(10);
  });
});

describe("purchase automation — it never orders", () => {
  beforeEach(resetDb);

  it("every generated order is a DRAFT", async () => {
    // THE constraint. Nothing here can place an order with a supplier.
    const shop = await shortShop();
    await shop.product("A-1", shop.acme.id, 2);

    await service.generateDraftPOs(shop.company.id, shop.user.id);

    const orders = await prisma.purchaseOrder.findMany();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe("DRAFT");
  });

  it("marks the order as generated, so the rules can be audited", async () => {
    // Answers a question the rules can't answer about themselves: are they
    // being acted on, or ignored? A rule nobody follows still looks like
    // coverage.
    const shop = await shortShop();
    await shop.product("A-1", shop.acme.id, 2);

    await service.generateDraftPOs(shop.company.id, shop.user.id);
    const po = await prisma.purchaseOrder.findFirstOrThrow();
    expect(po.generatedFrom).toBe("reorder");
  });

  it("a hand-raised order is not marked as generated", async () => {
    const shop = await shortShop();
    const p = await shop.product("A-1", shop.acme.id, 100); // not short
    const { createPO } = await import("../purchase-orders/po.service.js");

    await createPO(shop.company.id, shop.user.id, {
      supplierId: shop.acme.id,
      lines: [{ productId: p.id, quantity: 5, unitCost: 20 }],
    } as Parameters<typeof createPO>[2]);

    const po = await prisma.purchaseOrder.findFirstOrThrow();
    expect(po.generatedFrom).toBeNull();
  });
});

describe("purchase automation — what it refuses to guess", () => {
  beforeEach(resetDb);

  it("skips a product with no preferred supplier, and says why", async () => {
    // Choosing a supplier for the user would be inventing a commercial
    // relationship. The gap is reported so it can be fixed.
    const shop = await shortShop();
    await shop.product("ORPHAN", null, 2);

    const { created, skipped } = await service.generateDraftPOs(
      shop.company.id,
      shop.user.id
    );

    expect(created).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.sku).toBe("ORPHAN");
    expect(skipped[0]!.reason).toMatch(/supplier/i);
  });

  it("orders what it can and reports what it can't, in one pass", async () => {
    // A missing supplier on one product must not stop the rest being ordered.
    const shop = await shortShop();
    await shop.product("A-1", shop.acme.id, 2);
    await shop.product("ORPHAN", null, 2);

    const { created, skipped } = await service.generateDraftPOs(
      shop.company.id,
      shop.user.id
    );

    expect(created).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });

  it("generates nothing when nothing is short", async () => {
    const shop = await shortShop();
    await shop.product("A-1", shop.acme.id, 500); // well stocked

    const { created, skipped } = await service.generateDraftPOs(
      shop.company.id,
      shop.user.id
    );
    expect(created).toHaveLength(0);
    expect(skipped).toHaveLength(0);
    expect(await prisma.purchaseOrder.count()).toBe(0);
  });
});

describe("purchase automation — the generated order is a real order", () => {
  beforeEach(resetDb);

  it("goes through the ordinary create path — numbering, lines, costs", async () => {
    // Not a direct database write. Everything createPO enforces still applies.
    const shop = await shortShop();
    await shop.product("A-1", shop.acme.id, 2, 10, 25);

    await service.generateDraftPOs(shop.company.id, shop.user.id);

    const po = await prisma.purchaseOrder.findFirstOrThrow({
      include: { lines: true, supplier: true },
    });
    expect(po.number).toBe(1); // per-company sequence
    expect(po.supplier.name).toBe("Acme Supplies");
    expect(po.notes).toMatch(/review before ordering/i);
    // costPrice, not avgCost: this is what the supplier is expected to charge,
    // not what stock has historically cost.
    expect(Number(po.lines[0]!.unitCost)).toBe(25);
  });

  it("the location filter changes WHAT is ordered, not whether", async () => {
    // A shelf holding none of a tracked product is short BY DEFINITION —
    // onHand 0 is below any minimum. So filtering to an empty location doesn't
    // produce nothing; it produces an order sized for that empty shelf.
    //
    // Getting this wrong in a test is instructive: "no stock here" and "not
    // relevant here" look alike and are opposites. The rule that separates
    // them is the minimum — a zero minimum means don't track, and that is the
    // only thing that removes a shelf from the report.
    const shop = await shortShop();
    await shop.product("A-1", shop.acme.id, 2, 10); // 2 at Main, min 10

    const godown = await prisma.location.create({
      data: { companyId: shop.company.id, name: "Godown" },
    });

    const atMain = await service.generateDraftPOs(shop.company.id, shop.user.id, {
      locationId: shop.location.id,
    });
    const atGodown = await service.generateDraftPOs(
      shop.company.id,
      shop.user.id,
      { locationId: godown.id }
    );

    // Main holds 2 of a minimum of 10 → top up to twice the minimum, less
    // what's there. Godown holds none → it needs the full amount.
    expect(atMain.created).toHaveLength(1);
    expect(atGodown.created).toHaveLength(1);
    expect(atGodown.created[0]!.totalCost).toBeGreaterThan(
      atMain.created[0]!.totalCost
    );
  });

  it("can be limited to chosen products", async () => {
    const shop = await shortShop();
    const wanted = await shop.product("A-1", shop.acme.id, 2);
    await shop.product("A-2", shop.acme.id, 2);

    const { created } = await service.generateDraftPOs(
      shop.company.id,
      shop.user.id,
      { productIds: [wanted.id] }
    );

    expect(created).toHaveLength(1);
    expect(created[0]!.lineCount).toBe(1);
  });

  it("never reaches another company's recommendations", async () => {
    const ours = await shortShop();
    const theirs = await createTestCompany("Other Co");
    const theirSupplier = await prisma.supplier.create({
      data: { companyId: theirs.company.id, name: "Their Supplier" },
    });
    await prisma.product.update({
      where: { id: theirs.product.id },
      data: { lowStockThreshold: 100, preferredSupplierId: theirSupplier.id },
    });
    await stockService.createMovement(theirs.company.id, theirs.user.id, {
      productId: theirs.product.id,
      locationId: theirs.location.id,
      type: "PURCHASE",
      quantity: 1,
      unitCost: 10,
    } as Parameters<typeof stockService.createMovement>[2]);

    const { created } = await service.generateDraftPOs(
      ours.company.id,
      ours.user.id
    );
    expect(created).toHaveLength(0);
    expect(
      await prisma.purchaseOrder.count({ where: { companyId: ours.company.id } })
    ).toBe(0);
  });
});
