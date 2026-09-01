/**
 * Reservations (P2-1).
 *
 * The rule under test, from PRD §13:
 *
 *     Available = On Hand − Reserved
 *
 * and the thing that makes it more than arithmetic: a reservation must NOT
 * subtract physical stock. Stock that is reserved is still on the shelf, still
 * owned, still counted, still valued — it simply cannot be promised twice.
 *
 * The failure this prevents is a business one, not a technical one. Without
 * reservations nothing is wrong in the database at any point; you just find out
 * you've sold the same units to two customers when the second one arrives.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import * as stockService from "./stock.service.js";
import * as invService from "../invoices/inv.service.js";
import {
  availableQuantity,
  reservedQuantity,
} from "../../lib/reservations.js";
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

/** A company with 10 units of the test product on the shelf. */
async function stockedShop(quantity = 10) {
  const base = await createTestCompany();
  // quantity 0 means "leave the shelf empty" — a zero-quantity PURCHASE is
  // rejected by parseQuantity, and rightly so: it isn't an event.
  if (quantity > 0) {
    await stockService.createMovement(base.company.id, base.user.id, {
      productId: base.product.id,
      locationId: base.location.id,
      type: "PURCHASE",
      quantity,
      unitCost: 10,
    } as Parameters<typeof stockService.createMovement>[2]);
  }

  const draft = (qty: number) =>
    invService.createInvoice(base.company.id, base.user.id, {
      customerName: "Walk-in",
      locationId: base.location.id,
      lines: [{ productId: base.product.id, quantity: qty, unitPrice: 20 }],
    } as Parameters<typeof invService.createInvoice>[2]);

  const avail = () =>
    availableQuantity(prisma, base.company.id, {
      productId: base.product.id,
      locationId: base.location.id,
    });

  return { ...base, draft, avail };
}

describe("reservations — the core formula", () => {
  beforeEach(resetDb);

  it("a draft invoice reserves without moving any stock", async () => {
    // THE test. On hand must not budge — the goods are still on the shelf.
    const { draft, avail } = await stockedShop(10);
    await draft(4);

    const { onHand, reserved, available } = await avail();
    expect(Number(onHand)).toBe(10); // unchanged — nothing physically moved
    expect(Number(reserved)).toBe(4);
    expect(Number(available)).toBe(6);
  });

  it("writes NO stock movement for a reservation", async () => {
    // Belt and braces on the rule above: prove the ledger is untouched, not
    // just that the sum happens to be right.
    const { company, draft } = await stockedShop(10);
    const before = await prisma.stockMovement.count({
      where: { companyId: company.id },
    });
    await draft(4);
    expect(
      await prisma.stockMovement.count({ where: { companyId: company.id } })
    ).toBe(before);
  });

  it("reservations from several drafts add up", async () => {
    const { draft, avail } = await stockedShop(10);
    await draft(3);
    await draft(2);
    expect(Number((await avail()).reserved)).toBe(5);
    expect(Number((await avail()).available)).toBe(5);
  });

  it("a draft beyond available reserves only what's there, and still saves", async () => {
    // Drafting is work in progress, not a promise to the customer yet, so it
    // is never blocked — you must be able to write up an order before the
    // delivery that fills it arrives. It holds what it can and no more.
    const { draft, avail } = await stockedShop(10);
    await draft(8);

    const second = await draft(5); // only 2 are actually free
    expect(second.id).toBeTruthy(); // it saved

    const { onHand, reserved, available } = await avail();
    expect(Number(onHand)).toBe(10);
    // Reserved can never exceed on hand — a promise must not drive available
    // negative. 8 + 2, not 8 + 5.
    expect(Number(reserved)).toBe(10);
    expect(Number(available)).toBe(0);
  });

  it("but ISSUING that draft is refused — the real gate", async () => {
    // A draft may be optimistic; a sale may not. This is what makes the
    // permissive draft safe: nothing can be sold that doesn't exist.
    const { company, user, draft } = await stockedShop(10);
    await draft(8);
    const short = await draft(5);

    const err = await expectAppError(
      invService.issueInvoice(company.id, user.id, short.id),
      400
    );
    expect(err.message).toMatch(/not enough stock/i);
  });

  it("a draft for a product with no stock at all holds nothing", async () => {
    const { company, product, location, draft } = await stockedShop(0);
    await draft(5);

    const reserved = await reservedQuantity(prisma, company.id, {
      productId: product.id,
      locationId: location.id,
    });
    expect(Number(reserved)).toBe(0); // not −5, not 5 — nothing
  });

  it("a reservation blocks a direct sale of the same stock", async () => {
    const { company, user, product, location, draft } = await stockedShop(10);
    await draft(8);

    const err = await expectAppError(
      stockService.createMovement(company.id, user.id, {
        productId: product.id,
        locationId: location.id,
        type: "SALE",
        quantity: 5,
      } as Parameters<typeof stockService.createMovement>[2]),
      400
    );
    // The message must explain WHY, or a shelf holding 10 refusing a sale of 5
    // looks like a bug rather than a promise being kept.
    expect(err.message).toMatch(/reserved/i);
  });

  it("a sale within what's left still goes through", async () => {
    const { company, user, product, location, draft, avail } =
      await stockedShop(10);
    await draft(8);

    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "SALE",
      quantity: 2,
    } as Parameters<typeof stockService.createMovement>[2]);

    const { onHand, reserved, available } = await avail();
    expect(Number(onHand)).toBe(8);
    expect(Number(reserved)).toBe(8);
    expect(Number(available)).toBe(0);
  });

  it("blocks a transfer of reserved stock", async () => {
    // A reservation names a product AND a location. Moving the goods away
    // breaks the promise just as surely as selling them.
    const { company, user, product, location, draft } = await stockedShop(10);
    const other = await prisma.location.create({
      data: { companyId: company.id, name: "Warehouse B" },
    });
    await draft(8);

    const err = await expectAppError(
      stockService.transfer(company.id, user.id, {
        productId: product.id,
        fromLocationId: location.id,
        toLocationId: other.id,
        quantity: 5,
      } as Parameters<typeof stockService.transfer>[2]),
      400
    );
    expect(err.message).toMatch(/reserved/i);
  });
});

describe("reservations — the invoice lifecycle", () => {
  beforeEach(resetDb);

  it("issuing consumes its OWN reservation instead of being blocked by it", async () => {
    // The crux of the feature. A draft reserves its lines, so at issue time
    // the stock it needs is already spoken for — by itself. If that counted
    // against it, every draft would block its own issue and the more carefully
    // you reserved the more certainly you'd be refused.
    const { company, user, draft, avail } = await stockedShop(10);
    const inv = await draft(10); // reserves ALL of it

    await invService.issueInvoice(company.id, user.id, inv.id);

    const { onHand, reserved, available } = await avail();
    expect(Number(onHand)).toBe(0); // now it really has left
    expect(Number(reserved)).toBe(0); // the hold is spent, not lingering
    expect(Number(available)).toBe(0);
  });

  it("marks the hold CONSUMED, not RELEASED", async () => {
    // Both stop counting against availability, but only one is true, and the
    // reservation history is read by people trying to reconstruct events.
    const { company, user, draft } = await stockedShop(10);
    const inv = await draft(4);
    await invService.issueInvoice(company.id, user.id, inv.id);

    const rows = await prisma.stockReservation.findMany({
      where: { companyId: company.id, sourceId: inv.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("CONSUMED");
    expect(rows[0]!.consumedAt).not.toBeNull();
  });

  it("cancelling a draft releases its hold", async () => {
    // Otherwise a cancelled draft keeps stock off the shelf forever, with
    // nothing left in the UI to explain why.
    const { company, user, draft, avail } = await stockedShop(10);
    const inv = await draft(6);
    expect(Number((await avail()).available)).toBe(4);

    await invService.cancelInvoice(company.id, user.id, inv.id);

    const { onHand, reserved, available } = await avail();
    expect(Number(onHand)).toBe(10);
    expect(Number(reserved)).toBe(0);
    expect(Number(available)).toBe(10);
  });

  it("editing a draft replaces the hold rather than adding to it", async () => {
    const { company, draft, avail } = await stockedShop(10);
    const inv = await draft(6);

    await invService.updateInvoice(company.id, inv.id, {
      lines: [
        { productId: inv.lines[0]!.productId, quantity: 2, unitPrice: 20 },
      ],
    } as Parameters<typeof invService.updateInvoice>[2]);

    expect(Number((await avail()).reserved)).toBe(2); // not 8
    expect(Number((await avail()).available)).toBe(8);
  });

  it("a draft editing itself doesn't compete with its own hold", async () => {
    // Reserve everything, then re-save the same quantity. If the invoice's own
    // reservation counted against it, this no-op save would fail with "no
    // stock available" — on a shelf it has entirely to itself.
    const { company, draft, avail } = await stockedShop(10);
    const inv = await draft(10);

    await invService.updateInvoice(company.id, inv.id, {
      lines: [
        { productId: inv.lines[0]!.productId, quantity: 10, unitPrice: 20 },
      ],
    } as Parameters<typeof invService.updateInvoice>[2]);

    expect(Number((await avail()).reserved)).toBe(10);
  });

  it("cancelling an issued invoice restores stock and leaves no stray hold", async () => {
    const { company, user, draft, avail } = await stockedShop(10);
    const inv = await draft(4);
    await invService.issueInvoice(company.id, user.id, inv.id);
    await invService.cancelInvoice(company.id, user.id, inv.id);

    const { onHand, reserved, available } = await avail();
    expect(Number(onHand)).toBe(10); // stock came back
    expect(Number(reserved)).toBe(0); // and nothing is still held
    expect(Number(available)).toBe(10);
  });
});

describe("reservations — expiry and hygiene", () => {
  beforeEach(resetDb);

  it("an expired reservation stops holding stock immediately", async () => {
    // Availability must be right the moment the expiry passes, not once some
    // sweeper happens to run. A promise that has run out has stopped holding
    // stock whether or not a background job has noticed.
    const { company, user, product, location } = await stockedShop(10);
    await prisma.stockReservation.create({
      data: {
        companyId: company.id,
        productId: product.id,
        locationId: location.id,
        quantity: new Prisma.Decimal(5),
        status: "ACTIVE",
        sourceType: "manual",
        sourceId: "test-hold",
        expiresAt: new Date(Date.now() - 1000), // one second ago
        createdById: user.id,
      },
    });

    const reserved = await reservedQuantity(prisma, company.id, {
      productId: product.id,
      locationId: location.id,
    });
    expect(Number(reserved)).toBe(0);
  });

  it("a future expiry still holds", async () => {
    const { company, user, product, location } = await stockedShop(10);
    await prisma.stockReservation.create({
      data: {
        companyId: company.id,
        productId: product.id,
        locationId: location.id,
        quantity: new Prisma.Decimal(5),
        status: "ACTIVE",
        sourceType: "manual",
        sourceId: "test-hold",
        expiresAt: new Date(Date.now() + 60_000),
        createdById: user.id,
      },
    });

    const reserved = await reservedQuantity(prisma, company.id, {
      productId: product.id,
      locationId: location.id,
    });
    expect(Number(reserved)).toBe(5);
  });

  it("released and consumed holds don't count", async () => {
    const { company, user, product, location } = await stockedShop(10);
    for (const status of ["RELEASED", "CONSUMED"] as const) {
      await prisma.stockReservation.create({
        data: {
          companyId: company.id,
          productId: product.id,
          locationId: location.id,
          quantity: new Prisma.Decimal(3),
          status,
          sourceType: "manual",
          sourceId: `dead-${status}`,
          createdById: user.id,
          ...(status === "RELEASED"
            ? { releasedAt: new Date() }
            : { consumedAt: new Date() }),
        },
      });
    }

    const reserved = await reservedQuantity(prisma, company.id, {
      productId: product.id,
      locationId: location.id,
    });
    expect(Number(reserved)).toBe(0);
  });

  it("a hold at one location doesn't restrict another", async () => {
    const { company, user, product, location } = await stockedShop(10);
    const other = await prisma.location.create({
      data: { companyId: company.id, name: "Warehouse B" },
    });
    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: other.id,
      type: "PURCHASE",
      quantity: 10,
      unitCost: 10,
    } as Parameters<typeof stockService.createMovement>[2]);

    await prisma.stockReservation.create({
      data: {
        companyId: company.id,
        productId: product.id,
        locationId: location.id,
        quantity: new Prisma.Decimal(10),
        status: "ACTIVE",
        sourceType: "manual",
        sourceId: "hold-a",
        createdById: user.id,
      },
    });

    const b = await availableQuantity(prisma, company.id, {
      productId: product.id,
      locationId: other.id,
    });
    expect(Number(b.available)).toBe(10); // untouched by A's hold
  });

  it("stock levels report on hand, reserved and available separately", async () => {
    const { company, product, location, draft } = await stockedShop(10);
    await draft(4);

    const levels = await stockService.stockLevels(company.id, {
      take: 50,
      skip: 0,
    } as never);
    const row = levels.find(
      (l) => l.product.id === product.id && l.location.id === location.id
    )!;

    expect(Number(row.quantity)).toBe(10); // still means ON HAND
    expect(Number(row.reserved)).toBe(4);
    expect(Number(row.available)).toBe(6);
  });
});

describe("reservations — tenant isolation", () => {
  beforeEach(resetDb);

  it("another company's reservations never affect our availability", async () => {
    const ours = await stockedShop(10);
    const theirs = await createTestCompany("Other Co");

    await prisma.stockReservation.create({
      data: {
        companyId: theirs.company.id,
        productId: theirs.product.id,
        locationId: theirs.location.id,
        quantity: new Prisma.Decimal(10),
        status: "ACTIVE",
        sourceType: "manual",
        sourceId: "their-hold",
        createdById: theirs.user.id,
      },
    });

    expect(Number((await ours.avail()).available)).toBe(10);
  });
});
