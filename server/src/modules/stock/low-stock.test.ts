/**
 * The low-stock rule (BUG-2 from the testing round).
 *
 * The bug: a product could display "Alert: 0" — alerts off — while a location
 * badge on the same page read "low". Three copies of the rule had drifted
 * apart. `stockLevels` had no zero rule and ignored per-location minimums
 * entirely, so it disagreed with both the reorder report and the alerts.
 *
 * These tests pin the rule down in the one place it now lives
 * (lib/low-stock.ts) and, more importantly, assert that the SCREEN and the
 * REORDER REPORT reach the same verdict about the same shelf. A rule that is
 * only correct in one of the two places it's read is the bug, not the fix.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import * as stockService from "./stock.service.js";
import * as reorderService from "../reorder/reorder.service.js";
import {
  effectiveThreshold,
  isLowStock,
  isThresholdActive,
} from "../../lib/low-stock.js";
import { Dec } from "../../lib/quantity.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";

/** A product with a configurable threshold, in stock at two locations. */
async function shop(productThreshold: number) {
  const base = await createTestCompany();

  await prisma.product.update({
    where: { id: base.product.id },
    data: { lowStockThreshold: productThreshold },
  });

  const backOffice = await prisma.location.create({
    data: { companyId: base.company.id, name: "Back office" },
  });

  const put = (locationId: string, quantity: number) =>
    stockService.createMovement(base.company.id, base.user.id, {
      productId: base.product.id,
      locationId,
      type: "PURCHASE",
      quantity,
    } as Parameters<typeof stockService.createMovement>[2]);

  /** The row the Product Details page and the Stock page read. */
  const level = async (locationId: string) => {
    const rows = await stockService.stockLevels(base.company.id, {
      productId: base.product.id,
    });
    return rows.find((r) => r.location.id === locationId)!;
  };

  /** The same shelf, as the reorder report sees it. */
  const reorderRowFor = async (locationId: string) => {
    const rows = await reorderService.reorderReport(base.company.id, {});
    return rows.find(
      (r) => r.productId === base.product.id && r.locationId === locationId
    );
  };

  const setLocationMin = (locationId: string, minQuantity: number | null) =>
    prisma.productLocationSetting.upsert({
      where: {
        companyId_productId_locationId: {
          companyId: base.company.id,
          productId: base.product.id,
          locationId,
        },
      },
      create: {
        companyId: base.company.id,
        productId: base.product.id,
        locationId,
        minQuantity,
      },
      update: { minQuantity },
    });

  return { ...base, backOffice, put, level, reorderRowFor, setLocationMin };
}

describe("low-stock rule — the shared definition", () => {
  it("zero means OFF, not 'warn me at zero'", () => {
    expect(isThresholdActive(new Dec(0))).toBe(false);
    expect(isLowStock(new Dec(0), new Dec(0))).toBe(false);
    expect(isLowStock(new Dec(5), new Dec(0))).toBe(false);
  });

  it("at the threshold counts as low; above it does not", () => {
    expect(isLowStock(new Dec(10), new Dec(10))).toBe(true);
    expect(isLowStock(new Dec(9.9999), new Dec(10))).toBe(true);
    expect(isLowStock(new Dec(10.0001), new Dec(10))).toBe(false);
  });

  it("a location minimum REPLACES the product default, including a lower one", () => {
    expect(Number(effectiveThreshold(new Dec(10), new Dec(3)))).toBe(3);
    expect(Number(effectiveThreshold(new Dec(10), null))).toBe(10);
    expect(Number(effectiveThreshold(new Dec(10), undefined))).toBe(10);
    // A location may also switch alerts OFF for a shelf the product tracks.
    expect(isLowStock(new Dec(1), effectiveThreshold(new Dec(10), new Dec(0)))).toBe(
      false
    );
  });
});

describe("stock levels — what the Product Details page shows", () => {
  beforeEach(resetDb);

  it("normal: comfortably above the threshold is not low", async () => {
    const { location, put, level } = await shop(10);
    await put(location.id, 100);

    const row = await level(location.id);
    expect(row.lowStock).toBe(false);
    expect(Number(row.threshold)).toBe(10);
    expect(row.thresholdSource).toBe("product");
  });

  it("low: at or below the threshold is low, and reports the number it used", async () => {
    const { location, put, level } = await shop(10);
    await put(location.id, 10); // exactly at it

    const row = await level(location.id);
    expect(row.lowStock).toBe(true);
    expect(Number(row.threshold)).toBe(10);
  });

  it("threshold 0: an empty shelf is NOT low — this is the reported bug", async () => {
    // "Alert: 0" next to a red "low" badge was the complaint. Zero means the
    // product isn't tracked, so nothing about it may go red.
    const { company, user, product, location, put, level } = await shop(0);
    await put(location.id, 5);

    const row = await level(location.id);
    expect(Number(row.threshold)).toBe(0);
    expect(row.lowStock).toBe(false);

    // ...and still not low once the shelf is completely empty, which is the
    // exact case the missing zero-guard used to flag.
    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "SALE",
      quantity: 5,
    } as Parameters<typeof stockService.createMovement>[2]);

    const emptied = await level(location.id);
    expect(Number(emptied.available)).toBe(0);
    expect(emptied.lowStock).toBe(false);
  });

  it("respects a location's own minimum instead of the product default", async () => {
    const { location, backOffice, put, level, setLocationMin } = await shop(10);
    await put(location.id, 20);
    await put(backOffice.id, 20);

    // Both shelves hold 20 against a product default of 10 → neither is low.
    expect((await level(location.id)).lowStock).toBe(false);
    expect((await level(backOffice.id)).lowStock).toBe(false);

    // The back office is a slow shelf and wants a much higher minimum.
    await setLocationMin(backOffice.id, 50);

    const main = await level(location.id);
    const back = await level(backOffice.id);
    expect(main.lowStock).toBe(false); // untouched by the other shelf's rule
    expect(Number(main.threshold)).toBe(10);
    expect(main.thresholdSource).toBe("product");

    expect(back.lowStock).toBe(true);
    expect(Number(back.threshold)).toBe(50);
    expect(back.thresholdSource).toBe("location");
  });

  it("a location can switch alerts off for a product that is tracked elsewhere", async () => {
    const { location, put, level, setLocationMin } = await shop(10);
    await put(location.id, 2); // below the product default

    expect((await level(location.id)).lowStock).toBe(true);

    await setLocationMin(location.id, 0);
    const off = await level(location.id);
    expect(off.lowStock).toBe(false);
    expect(Number(off.threshold)).toBe(0);
  });

  it("changing the threshold changes the verdict immediately", async () => {
    // Nothing is cached or denormalised: the next read reflects the new
    // configuration, on every screen.
    const { location, product, put, level } = await shop(10);
    await put(location.id, 20);
    expect((await level(location.id)).lowStock).toBe(false);

    await prisma.product.update({
      where: { id: product.id },
      data: { lowStockThreshold: 25 },
    });

    const after = await level(location.id);
    expect(after.lowStock).toBe(true);
    expect(Number(after.threshold)).toBe(25);
  });

  it("the screen and the reorder report agree about the same shelf", async () => {
    // The whole point of the fix. These two used different rules before.
    const { location, put, level, reorderRowFor, setLocationMin } =
      await shop(10);
    await put(location.id, 8);

    expect((await level(location.id)).lowStock).toBe(true);
    expect(await reorderRowFor(location.id)).toBeTruthy();

    // Raise the shelf's own minimum well above stock — both must agree it's low.
    await setLocationMin(location.id, 100);
    expect((await level(location.id)).lowStock).toBe(true);
    expect((await reorderRowFor(location.id))?.minQuantity).toBe(100);

    // Switch it off for this shelf — both must go quiet.
    await setLocationMin(location.id, 0);
    expect((await level(location.id)).lowStock).toBe(false);
    expect(await reorderRowFor(location.id)).toBeUndefined();
  });
});
