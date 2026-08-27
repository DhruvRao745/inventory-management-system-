/**
 * Location-aware reordering (P1-8).
 *
 * The bug this fixes, straight from PRD §11:
 *
 *     Warehouse A: 2 units    Warehouse B: 100 units    minimum: 10
 *
 * The old report summed to 102, sailed past the threshold, and raised no
 * warning — while Warehouse A sat nearly empty. A company total tells you
 * nothing about the shelf someone is standing at.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import * as service from "./reorder.service.js";
import * as stockService from "../stock/stock.service.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";

async function expectAppError(promise: Promise<unknown>, statusCode: number) {
  const err = await promise.then(
    () => null,
    (e) => e
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).statusCode).toBe(statusCode);
  return err as AppError;
}

/** Two warehouses, one product with a company-wide minimum of 10. */
async function twoWarehouses() {
  const base = await createTestCompany();
  await prisma.product.update({
    where: { id: base.product.id },
    data: { lowStockThreshold: 10 },
  });

  const warehouseB = await prisma.location.create({
    data: { companyId: base.company.id, name: "Warehouse B" },
  });

  const stockUp = (locationId: string, quantity: number) =>
    stockService.createMovement(base.company.id, base.user.id, {
      productId: base.product.id,
      locationId,
      type: "PURCHASE",
      quantity,
      unitCost: 10,
    } as Parameters<typeof stockService.createMovement>[2]);

  return { ...base, warehouseA: base.location, warehouseB, stockUp };
}

describe("reordering — the PRD §11 case", () => {
  beforeEach(resetDb);

  it("a nearly-empty warehouse triggers a reorder even when another is full", async () => {
    // THE test. Old behaviour: 2 + 100 = 102 > 10, no warning.
    const { company, warehouseA, warehouseB, stockUp } = await twoWarehouses();
    await stockUp(warehouseA.id, 2);
    await stockUp(warehouseB.id, 100);

    const rows = await service.reorderReport(company.id);

    const a = rows.find((r) => r.locationId === warehouseA.id);
    expect(a).toBeDefined();
    expect(a!.onHand).toBe(2);
    expect(a!.minQuantity).toBe(10);

    // And the full warehouse is NOT flagged.
    expect(rows.find((r) => r.locationId === warehouseB.id)).toBeUndefined();
  });

  it("reports one row per short shelf, not one per product", async () => {
    // "Warehouse A needs 8" and "Shop needs 3" are two different jobs.
    const { company, warehouseA, warehouseB, stockUp } = await twoWarehouses();
    await stockUp(warehouseA.id, 2);
    await stockUp(warehouseB.id, 4);

    const rows = await service.reorderReport(company.id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.locationId)).size).toBe(2);
  });

  it("filters to one location", async () => {
    const { company, warehouseA, warehouseB, stockUp } = await twoWarehouses();
    await stockUp(warehouseA.id, 2);
    await stockUp(warehouseB.id, 4);

    const rows = await service.reorderReport(company.id, {
      locationId: warehouseA.id,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.locationId).toBe(warehouseA.id);
  });

  it("sorts the emptiest shelves first", async () => {
    const { company, warehouseA, warehouseB, stockUp } = await twoWarehouses();
    await stockUp(warehouseA.id, 8); // 2 below min
    await stockUp(warehouseB.id, 1); // 9 below min

    const rows = await service.reorderReport(company.id);
    expect(rows[0]!.locationId).toBe(warehouseB.id); // worst first
  });
});

describe("reordering — per-location rules", () => {
  beforeEach(resetDb);

  it("a location's own minimum overrides the product default", async () => {
    const { company, product, warehouseA, warehouseB, stockUp } =
      await twoWarehouses();
    await stockUp(warehouseA.id, 20);
    await stockUp(warehouseB.id, 20);

    // The shop needs deeper cover than the default 10.
    await service.upsertSetting(company.id, {
      productId: product.id,
      locationId: warehouseA.id,
      minQuantity: 50,
    } as Parameters<typeof service.upsertSetting>[1]);

    const rows = await service.reorderReport(company.id);
    expect(rows).toHaveLength(1); // only A, which is now "short" at 20
    expect(rows[0]!.locationId).toBe(warehouseA.id);
    expect(rows[0]!.minQuantity).toBe(50);
    expect(rows[0]!.locationSpecific).toBe(true);
  });

  it("falls back to the product default where no rule is set", async () => {
    const { company, warehouseA, stockUp } = await twoWarehouses();
    await stockUp(warehouseA.id, 5);

    const rows = await service.reorderReport(company.id);
    const a = rows.find((r) => r.locationId === warehouseA.id)!;
    expect(a.minQuantity).toBe(10);
    expect(a.locationSpecific).toBe(false);
  });

  it("a zero minimum means 'don't track here'", async () => {
    // Otherwise every product at every location shows up the moment it hits
    // zero, burying the shelves that genuinely need attention.
    const { company, product, warehouseA, warehouseB, stockUp } =
      await twoWarehouses();
    await stockUp(warehouseB.id, 100);
    await service.upsertSetting(company.id, {
      productId: product.id,
      locationId: warehouseA.id,
      minQuantity: 0,
    } as Parameters<typeof service.upsertSetting>[1]);

    const rows = await service.reorderReport(company.id);
    expect(rows.find((r) => r.locationId === warehouseA.id)).toBeUndefined();
  });
});

describe("reordering — how much to order", () => {
  beforeEach(resetDb);

  it("tops back up to the maximum when one is set", async () => {
    const { company, product, warehouseA, stockUp } = await twoWarehouses();
    await stockUp(warehouseA.id, 4);
    await service.upsertSetting(company.id, {
      productId: product.id,
      locationId: warehouseA.id,
      minQuantity: 10,
      maxQuantity: 60,
    } as Parameters<typeof service.upsertSetting>[1]);

    const rows = await service.reorderReport(company.id);
    // Pick the shelf under test by id — the OTHER warehouse is empty, so it
    // legitimately appears too, and sorts ahead of this one.
    const a = rows.find((r) => r.locationId === warehouseA.id)!;
    expect(a.suggestedQty).toBe(56); // 60 − 4
    expect(a.maxQuantity).toBe(60);
  });

  it("a fixed reorder quantity wins over the max calculation", async () => {
    // For suppliers who only sell by the pallet.
    const { company, product, warehouseA, stockUp } = await twoWarehouses();
    await stockUp(warehouseA.id, 4);
    await service.upsertSetting(company.id, {
      productId: product.id,
      locationId: warehouseA.id,
      minQuantity: 10,
      maxQuantity: 60,
      reorderQuantity: 100,
    } as Parameters<typeof service.upsertSetting>[1]);

    const rows = await service.reorderReport(company.id);
    expect(
      rows.find((r) => r.locationId === warehouseA.id)!.suggestedQty
    ).toBe(100);
  });

  it("falls back to twice the minimum when nothing better is known", async () => {
    const { company, warehouseA, stockUp } = await twoWarehouses();
    await stockUp(warehouseA.id, 4);

    const rows = await service.reorderReport(company.id);
    expect(
      rows.find((r) => r.locationId === warehouseA.id)!.suggestedQty
    ).toBe(16); // 2×10 − 4
  });

  it("never suggests less than one unit", async () => {
    // "Order 0.4" helps nobody.
    const { company, product, warehouseA, stockUp } = await twoWarehouses();
    await stockUp(warehouseA.id, 10); // exactly at the minimum
    await service.upsertSetting(company.id, {
      productId: product.id,
      locationId: warehouseA.id,
      minQuantity: 10,
      maxQuantity: 10,
    } as Parameters<typeof service.upsertSetting>[1]);

    const rows = await service.reorderReport(company.id);
    expect(
      rows.find((r) => r.locationId === warehouseA.id)!.suggestedQty
    ).toBe(1);
  });
});

describe("reordering — preferred supplier per location", () => {
  beforeEach(resetDb);

  it("a location's supplier overrides the product's", async () => {
    // A northern warehouse may buy from a different local supplier.
    const { company, product, warehouseA, stockUp } = await twoWarehouses();
    const national = await prisma.supplier.create({
      data: { companyId: company.id, name: "National Wholesale" },
    });
    const local = await prisma.supplier.create({
      data: { companyId: company.id, name: "Local Depot" },
    });
    await prisma.product.update({
      where: { id: product.id },
      data: { preferredSupplierId: national.id },
    });
    await stockUp(warehouseA.id, 2);

    await service.upsertSetting(company.id, {
      productId: product.id,
      locationId: warehouseA.id,
      preferredSupplierId: local.id,
    } as Parameters<typeof service.upsertSetting>[1]);

    const rows = await service.reorderReport(company.id);
    expect(
      rows.find((r) => r.locationId === warehouseA.id)!.preferredSupplier?.name
    ).toBe("Local Depot");
  });

  it("falls back to the product's supplier", async () => {
    const { company, product, warehouseA, stockUp } = await twoWarehouses();
    const national = await prisma.supplier.create({
      data: { companyId: company.id, name: "National Wholesale" },
    });
    await prisma.product.update({
      where: { id: product.id },
      data: { preferredSupplierId: national.id },
    });
    await stockUp(warehouseA.id, 2);

    const rows = await service.reorderReport(company.id);
    expect(
      rows.find((r) => r.locationId === warehouseA.id)!.preferredSupplier?.name
    ).toBe("National Wholesale");
  });
});

describe("reordering — settings CRUD", () => {
  beforeEach(resetDb);

  it("upsert creates then updates the same row", async () => {
    const { company, product, warehouseA } = await twoWarehouses();
    const first = await service.upsertSetting(company.id, {
      productId: product.id,
      locationId: warehouseA.id,
      minQuantity: 5,
    } as Parameters<typeof service.upsertSetting>[1]);
    const second = await service.upsertSetting(company.id, {
      productId: product.id,
      locationId: warehouseA.id,
      minQuantity: 25,
    } as Parameters<typeof service.upsertSetting>[1]);

    expect(second.id).toBe(first.id); // one rule per shelf, not two
    expect(Number(second.minQuantity)).toBe(25);
    expect(await prisma.productLocationSetting.count()).toBe(1);
  });

  it("refuses a maximum below the minimum", async () => {
    // It would ask for a negative order, surfacing as a mystifying "1".
    const { company, product, warehouseA } = await twoWarehouses();
    await expectAppError(
      service.upsertSetting(company.id, {
        productId: product.id,
        locationId: warehouseA.id,
        minQuantity: 50,
        maxQuantity: 10,
      } as Parameters<typeof service.upsertSetting>[1]),
      400
    );
  });

  it("deleting a rule reverts that shelf to the product default", async () => {
    const { company, product, warehouseA, warehouseB, stockUp } =
      await twoWarehouses();
    await stockUp(warehouseA.id, 20);
    // Keep the other warehouse well stocked so it stays out of the report
    // and this test is about A alone.
    await stockUp(warehouseB.id, 100);

    const setting = await service.upsertSetting(company.id, {
      productId: product.id,
      locationId: warehouseA.id,
      minQuantity: 50,
    } as Parameters<typeof service.upsertSetting>[1]);

    expect(await service.reorderReport(company.id)).toHaveLength(1);

    await service.deleteSetting(company.id, setting.id);
    // Back to the product default of 10 — and 20 is above it.
    expect(await service.reorderReport(company.id)).toHaveLength(0);
  });

  it("rejects a product, location or supplier from another company", async () => {
    const a = await createTestCompany("Alpha");
    const b = await createTestCompany("Beta");

    await expectAppError(
      service.upsertSetting(a.company.id, {
        productId: b.product.id,
        locationId: a.location.id,
      } as Parameters<typeof service.upsertSetting>[1]),
      404
    );
    await expectAppError(
      service.upsertSetting(a.company.id, {
        productId: a.product.id,
        locationId: b.location.id,
      } as Parameters<typeof service.upsertSetting>[1]),
      404
    );
  });
});
