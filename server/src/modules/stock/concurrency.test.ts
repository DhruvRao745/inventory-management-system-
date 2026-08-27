/**
 * Concurrency tests — the ones that matter most.
 *
 * Everything else in this suite runs one request at a time, which is exactly
 * the condition under which the oversell bug is INVISIBLE. These tests fire
 * real simultaneous requests down separate connections and check the ledger
 * survives.
 *
 * The rule being defended:
 *
 *     stock may never go negative, no matter how many requests arrive at once
 *
 * Without the advisory lock in lib/locks.ts these tests fail: two requests
 * both read "10 available", both pass their check, and both write.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import * as stockService from "./stock.service.js";
import * as invService from "../invoices/inv.service.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";

/** Run promises together and sort them into winners and losers. */
async function settle<T>(promises: Promise<T>[]) {
  const results = await Promise.allSettled(promises);
  return {
    ok: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
    errors: results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason),
  };
}

describe("concurrency — stock can never go negative", () => {
  beforeEach(resetDb);

  it("PRD acceptance: stock 10, simultaneous 8 and 7 — only one wins", async () => {
    const { company, user, location, product } = await createTestCompany();
    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "PURCHASE",
      quantity: 10,
    });

    // Fire both WITHOUT awaiting in between — this is the whole point.
    const { ok, failed, errors } = await settle([
      stockService.createMovement(company.id, user.id, {
        productId: product.id,
        locationId: location.id,
        type: "SALE",
        quantity: 8,
      }),
      stockService.createMovement(company.id, user.id, {
        productId: product.id,
        locationId: location.id,
        type: "SALE",
        quantity: 7,
      }),
    ]);

    expect(ok).toBe(1);
    expect(failed).toBe(1);
    // The loser must fail for the RIGHT reason — a 400 "not enough stock",
    // not a deadlock, timeout or constraint crash.
    expect(errors[0]).toBeInstanceOf(AppError);
    expect((errors[0] as AppError).statusCode).toBe(400);

    const level = Number(
      await stockService.getStockLevel(company.id, product.id, location.id)
    );
    // Whichever sale won, exactly one happened: 10−8=2 or 10−7=3.
    // Before the fix this was 10−8−7 = −5.
    expect([2, 3]).toContain(level);
  });

  it("ten simultaneous single-unit sales against stock of 5 — exactly 5 win", async () => {
    const { company, user, location, product } = await createTestCompany();
    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "PURCHASE",
      quantity: 5,
    });

    const { ok, failed } = await settle(
      Array.from({ length: 10 }, () =>
        stockService.createMovement(company.id, user.id, {
          productId: product.id,
          locationId: location.id,
          type: "SALE",
          quantity: 1,
        })
      )
    );

    expect(ok).toBe(5);
    expect(failed).toBe(5);
    expect(
      Number(await stockService.getStockLevel(company.id, product.id, location.id))
    ).toBe(0);
  });

  it("simultaneous transfers out of one location cannot overdraw it", async () => {
    const { company, user, location, product } = await createTestCompany();
    const dest = await prisma.location.create({
      data: { companyId: company.id, name: "Godown" },
    });
    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "PURCHASE",
      quantity: 10,
    });

    const { ok } = await settle([
      stockService.transfer(company.id, user.id, {
        productId: product.id,
        fromLocationId: location.id,
        toLocationId: dest.id,
        quantity: 8,
      }),
      stockService.transfer(company.id, user.id, {
        productId: product.id,
        fromLocationId: location.id,
        toLocationId: dest.id,
        quantity: 7,
      }),
    ]);

    expect(ok).toBe(1);
    const source = Number(
      await stockService.getStockLevel(company.id, product.id, location.id)
    );
    expect(source).toBeGreaterThanOrEqual(0);

    // The books must still balance: what left the source arrived at the dest.
    const moved = Number(
      await stockService.getStockLevel(company.id, product.id, dest.id)
    );
    expect(source + moved).toBe(10);
  });

  it("opposing simultaneous transfers do not deadlock", async () => {
    // A→B and B→A at the same time. Each locks two keys; without a
    // deterministic lock ORDER these two transactions deadlock.
    const { company, user, location, product } = await createTestCompany();
    const other = await prisma.location.create({
      data: { companyId: company.id, name: "Godown" },
    });
    for (const loc of [location.id, other.id]) {
      await stockService.createMovement(company.id, user.id, {
        productId: product.id,
        locationId: loc,
        type: "PURCHASE",
        quantity: 20,
      });
    }

    const { ok, failed, errors } = await settle([
      stockService.transfer(company.id, user.id, {
        productId: product.id,
        fromLocationId: location.id,
        toLocationId: other.id,
        quantity: 5,
      }),
      stockService.transfer(company.id, user.id, {
        productId: product.id,
        fromLocationId: other.id,
        toLocationId: location.id,
        quantity: 5,
      }),
    ]);

    // Both have plenty of stock, so both SHOULD succeed. A deadlock would
    // show up as a rejection here.
    if (failed > 0) console.error("deadlock/unexpected:", errors);
    expect(ok).toBe(2);
    expect(
      Number(await stockService.getStockLevel(company.id, product.id, location.id))
    ).toBe(20);
  });

  it("simultaneous invoice issues cannot oversell the same location", async () => {
    const { company, user, location, product } = await createTestCompany();
    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "PURCHASE",
      quantity: 10,
    });

    const mk = () =>
      invService.createInvoice(company.id, user.id, {
        customerName: "Walk-in",
        locationId: location.id,
        lines: [{ productId: product.id, quantity: 8, unitPrice: 20 }],
      } as Parameters<typeof invService.createInvoice>[2]);

    const a = await mk();
    const b = await mk();

    const { ok, failed } = await settle([
      invService.issueInvoice(company.id, user.id, a.id),
      invService.issueInvoice(company.id, user.id, b.id),
    ]);

    expect(ok).toBe(1);
    expect(failed).toBe(1);
    expect(
      Number(await stockService.getStockLevel(company.id, product.id, location.id))
    ).toBe(2);
  });

  it("different products do not block each other", async () => {
    // The lock is per product+location, so unrelated sales must stay parallel.
    const { company, user, location, product } = await createTestCompany();
    const second = await prisma.product.create({
      data: {
        companyId: company.id,
        sku: "TEST-002",
        name: "Other Widget",
        costPrice: 1,
        sellingPrice: 2,
      },
    });
    for (const p of [product.id, second.id]) {
      await stockService.createMovement(company.id, user.id, {
        productId: p,
        locationId: location.id,
        type: "PURCHASE",
        quantity: 10,
      });
    }

    const { ok } = await settle([
      stockService.createMovement(company.id, user.id, {
        productId: product.id,
        locationId: location.id,
        type: "SALE",
        quantity: 10,
      }),
      stockService.createMovement(company.id, user.id, {
        productId: second.id,
        locationId: location.id,
        type: "SALE",
        quantity: 10,
      }),
    ]);

    expect(ok).toBe(2);
  });
});

describe("concurrency — per-company numbering", () => {
  beforeEach(resetDb);

  it("simultaneous invoice creates get distinct sequential numbers", async () => {
    const { company, user, location, product } = await createTestCompany();

    const { ok, failed, errors } = await settle(
      Array.from({ length: 5 }, () =>
        invService.createInvoice(company.id, user.id, {
          customerName: "Walk-in",
          locationId: location.id,
          lines: [{ productId: product.id, quantity: 1, unitPrice: 20 }],
        } as Parameters<typeof invService.createInvoice>[2])
      )
    );

    // Previously two racers computed the same number and one blew up on the
    // unique index as an unhandled P2002 → 500.
    if (failed > 0) console.error("numbering failures:", errors);
    expect(ok).toBe(5);

    const numbers = (
      await prisma.invoice.findMany({
        where: { companyId: company.id },
        select: { number: true },
        orderBy: { number: "asc" },
      })
    ).map((i) => i.number);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
  });
});
