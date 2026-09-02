/**
 * A GST-registered company must decide every product's rate (follow-on to the
 * `stampGst` guard).
 *
 * The invoice-level check catches the problem at the moment of sale, which at
 * a till is the worst time to find out. This moves it to product creation —
 * the calmest moment there is, when nobody is waiting.
 *
 * The rule is CONDITIONAL on purpose, and the tests below are mostly about
 * that condition. Plenty of shops here never raise a GST invoice; requiring a
 * tax rate from them would get a number typed to escape the form, which puts
 * junk in the field instead of an honest blank.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import * as service from "./product.service.js";
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

const newProduct = (extra: Record<string, unknown> = {}) =>
  ({
    sku: `SKU-${Math.random().toString(36).slice(2, 8)}`,
    name: "Something",
    unit: "pcs",
    costPrice: 10,
    sellingPrice: 20,
    ...extra,
  }) as Parameters<typeof service.createProduct>[1];

/** A company registered for GST. */
async function gstCompany() {
  const base = await createTestCompany();
  await prisma.company.update({
    where: { id: base.company.id },
    data: { stateCode: "27", gstin: "27AAPFU0939F1ZV" },
  });
  return base;
}

describe("product GST rate — required for GST businesses", () => {
  beforeEach(resetDb);

  it("refuses a new product with no rate", async () => {
    const c = await gstCompany();
    const err = await expectAppError(
      service.createProduct(c.company.id, newProduct()),
      400
    );
    expect(err.message).toMatch(/GST rate/i);
  });

  it("accepts an explicit 0 — nil-rated goods are real", async () => {
    // The entire point of the rule. 0 is a decision; blank is not.
    const c = await gstCompany();
    const p = await service.createProduct(
      c.company.id,
      newProduct({ gstRate: 0 })
    );
    expect(Number(p.gstRate)).toBe(0);
  });

  it("accepts a normal rate", async () => {
    const c = await gstCompany();
    const p = await service.createProduct(
      c.company.id,
      newProduct({ gstRate: 18 })
    );
    expect(Number(p.gstRate)).toBe(18);
  });

  it("explains that blank and zero are different", async () => {
    // The message has to do the teaching — this is the first time most users
    // meet the distinction, and "field required" would not convey it.
    const c = await gstCompany();
    const err = await expectAppError(
      service.createProduct(c.company.id, newProduct()),
      400
    );
    expect(err.message).toMatch(/nil-rated|exempt/i);
    expect(err.message).toMatch(/0/);
  });
});

describe("product GST rate — NOT required without GST registration", () => {
  beforeEach(resetDb);

  it("lets a non-GST company leave it blank", async () => {
    // No state code, no GSTIN: this shop cannot raise a GST invoice at all,
    // so the field has nothing to be wrong about.
    const base = await createTestCompany();
    const p = await service.createProduct(base.company.id, newProduct());
    expect(p.gstRate).toBeNull();
  });

  it("starts requiring it once the business registers", async () => {
    // The rule follows the registration rather than a separate setting, so
    // turning on GST cannot leave the catalogue half-configured without
    // anyone noticing.
    const base = await createTestCompany();
    await service.createProduct(base.company.id, newProduct());

    await prisma.company.update({
      where: { id: base.company.id },
      data: { stateCode: "27" },
    });

    await expectAppError(
      service.createProduct(base.company.id, newProduct()),
      400
    );
  });
});

describe("product GST rate — cleaning up existing products", () => {
  beforeEach(resetDb);

  /** A product that predates the rule: created before the company registered. */
  async function legacyProduct() {
    const base = await createTestCompany();
    const p = await service.createProduct(base.company.id, newProduct());
    await prisma.company.update({
      where: { id: base.company.id },
      data: { stateCode: "27" },
    });
    return { ...base, legacy: p };
  }

  it("asks for the rate the next time the product is edited", async () => {
    // No backfill is possible — nobody can infer a tax rate from a product
    // name, and guessing would be the exact mistake this rule exists to stop.
    // So the cleanup happens when someone already has the product open.
    const c = await legacyProduct();
    await expectAppError(
      service.updateProduct(c.company.id, c.legacy.id, { name: "Renamed" }),
      400
    );
  });

  it("saves once a rate is supplied", async () => {
    const c = await legacyProduct();
    const updated = await service.updateProduct(c.company.id, c.legacy.id, {
      name: "Renamed",
      gstRate: 12,
    });
    expect(updated.name).toBe("Renamed");
    expect(Number(updated.gstRate)).toBe(12);
  });

  it("does not re-ask once the rate is set", async () => {
    // An edit that doesn't mention gstRate must not be blocked by a rate the
    // product already has — otherwise every future edit re-litigates it.
    const c = await legacyProduct();
    await service.updateProduct(c.company.id, c.legacy.id, { gstRate: 5 });
    const again = await service.updateProduct(c.company.id, c.legacy.id, {
      name: "Renamed twice",
    });
    expect(again.name).toBe("Renamed twice");
    expect(Number(again.gstRate)).toBe(5);
  });

  it("does not block edits for a company with no GST registration", async () => {
    const base = await createTestCompany();
    const p = await service.createProduct(base.company.id, newProduct());
    const updated = await service.updateProduct(base.company.id, p.id, {
      name: "Renamed",
    });
    expect(updated.name).toBe("Renamed");
  });

  it("leaves existing products SELLABLE on a flat invoice", async () => {
    // Nothing breaks today. The rule gates writing a product, not selling one
    // — a non-GST invoice makes no claim about tax, so it is unaffected.
    const c = await legacyProduct();
    const fresh = await service.getProduct(c.company.id, c.legacy.id);
    expect(fresh.gstRate).toBeNull();
    expect(fresh.isActive).toBe(true);
  });
});
