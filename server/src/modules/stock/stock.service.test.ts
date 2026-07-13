/**
 * Stock service tests — the robot customer for the diary keeper.
 *
 * The pattern of every test: ARRANGE (set the stage) →
 * ACT (do the thing) → ASSERT (check the receipt).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import * as stockService from "./stock.service.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";

// catch an expected failure so we can inspect it
async function expectAppError(promise: Promise<unknown>, statusCode: number) {
  const err = await promise.then(
    () => null,
    (e) => e
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).statusCode).toBe(statusCode);
  return err as AppError;
}

describe("stock service", () => {
  beforeEach(resetDb); // blank shop before every test

  it("applies the sign rule: purchase +, sale −", async () => {
    const { company, user, location, product } = await createTestCompany();

    const purchase = await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "PURCHASE",
      quantity: 100,
    });
    expect(purchase.quantity).toBe(100);

    const sale = await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "SALE",
      quantity: 3, // client sends POSITIVE...
    });
    expect(sale.quantity).toBe(-3); // ...server stores NEGATIVE

    const level = await stockService.getStockLevel(
      company.id,
      product.id,
      location.id
    );
    expect(level).toBe(97);
  });

  it("rejects overselling and leaves no trace", async () => {
    const { company, user, location, product } = await createTestCompany();
    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "PURCHASE",
      quantity: 5,
    });

    const err = await expectAppError(
      stockService.createMovement(company.id, user.id, {
        productId: product.id,
        locationId: location.id,
        type: "SALE",
        quantity: 10,
      }),
      400
    );
    expect(err.message).toContain("Not enough stock");

    // the failed sale must NOT have written a diary line
    const count = await prisma.stockMovement.count({
      where: { companyId: company.id },
    });
    expect(count).toBe(1); // only the purchase

    const level = await stockService.getStockLevel(
      company.id,
      product.id,
      location.id
    );
    expect(level).toBe(5); // untouched
  });

  it("allows negative adjustments within stock, rejects below zero", async () => {
    const { company, user, location, product } = await createTestCompany();
    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "PURCHASE",
      quantity: 10,
    });

    const adj = await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "ADJUSTMENT",
      quantity: -2, // adjustments arrive already signed
    });
    expect(adj.quantity).toBe(-2);

    await expectAppError(
      stockService.createMovement(company.id, user.id, {
        productId: product.id,
        locationId: location.id,
        type: "ADJUSTMENT",
        quantity: -100,
      }),
      400
    );
  });

  it("creates transfer twins: paired, linked, balanced", async () => {
    const { company, user, location, product } = await createTestCompany();
    const godown = await prisma.location.create({
      data: { companyId: company.id, name: "Godown" },
    });
    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "PURCHASE",
      quantity: 50,
    });

    const result = await stockService.transfer(company.id, user.id, {
      productId: product.id,
      fromLocationId: location.id,
      toLocationId: godown.id,
      quantity: 20,
    });

    // the twins: −20 out, +20 in, stapled by the same transferId
    expect(result.out.quantity).toBe(-20);
    expect(result.in.quantity).toBe(20);
    expect(result.out.transferId).toBe(result.in.transferId);

    // the books balance
    const atMain = await stockService.getStockLevel(
      company.id,
      product.id,
      location.id
    );
    const atGodown = await stockService.getStockLevel(
      company.id,
      product.id,
      godown.id
    );
    expect(atMain).toBe(30);
    expect(atGodown).toBe(20);
    expect(atMain + atGodown).toBe(50); // nothing created or destroyed
  });

  it("rejects a too-large transfer atomically — no orphan twin", async () => {
    const { company, user, location, product } = await createTestCompany();
    const godown = await prisma.location.create({
      data: { companyId: company.id, name: "Godown" },
    });
    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "PURCHASE",
      quantity: 5,
    });

    await expectAppError(
      stockService.transfer(company.id, user.id, {
        productId: product.id,
        fromLocationId: location.id,
        toLocationId: godown.id,
        quantity: 999,
      }),
      400
    );

    // neither an OUT nor an IN row may exist — all or nothing
    const transferRows = await prisma.stockMovement.count({
      where: { companyId: company.id, transferId: { not: null } },
    });
    expect(transferRows).toBe(0);
  });

  it("TENANT ISOLATION: company A cannot move company B's stock", async () => {
    const a = await createTestCompany("Company A");
    const b = await createTestCompany("Company B");

    // A tries to sell B's product from B's location — must be "not found",
    // as if B's data doesn't exist at all
    await expectAppError(
      stockService.createMovement(a.company.id, a.user.id, {
        productId: b.product.id,
        locationId: b.location.id,
        type: "PURCHASE",
        quantity: 10,
      }),
      404
    );

    // and B's diary must be empty — nothing leaked through
    const bMovements = await prisma.stockMovement.count({
      where: { companyId: b.company.id },
    });
    expect(bMovements).toBe(0);
  });

  it("refuses movements on retired products", async () => {
    const { company, user, location, product } = await createTestCompany();
    await prisma.product.update({
      where: { id: product.id },
      data: { isActive: false },
    });

    const err = await expectAppError(
      stockService.createMovement(company.id, user.id, {
        productId: product.id,
        locationId: location.id,
        type: "PURCHASE",
        quantity: 10,
      }),
      400
    );
    expect(err.message).toContain("retired");
  });
});
