/**
 * Sales returns (P1-6).
 *
 * The rule under test (PRD §9): "Only sellable returned stock should increase
 * available stock."
 *
 * Before this feature the only reversal was cancelling a whole invoice, which
 * restored every line in full — and anything returned went straight back into
 * sellable stock regardless of what condition it arrived in.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import * as returnService from "./return.service.js";
import * as invService from "../invoices/inv.service.js";
import * as stockService from "../stock/stock.service.js";
import { availableQuantity } from "../../lib/reservations.js";
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

/** 100 units in stock, 10 sold at ₹50 on an issued invoice. */
async function soldSetup() {
  const base = await createTestCompany();
  await stockService.createMovement(base.company.id, base.user.id, {
    productId: base.product.id,
    locationId: base.location.id,
    type: "PURCHASE",
    quantity: 100,
    unitCost: 20,
  } as Parameters<typeof stockService.createMovement>[2]);

  const invoice = await invService.createInvoice(base.company.id, base.user.id, {
    customerName: "Ravi Kumar",
    locationId: base.location.id,
    lines: [{ productId: base.product.id, quantity: 10, unitPrice: 50 }],
  } as Parameters<typeof invService.createInvoice>[2]);
  await invService.issueInvoice(base.company.id, base.user.id, invoice.id);

  const full = await invService.getInvoice(base.company.id, invoice.id);
  const invoiceLineId = full.lines[0]!.id;

  const raise = (
    quantity: number,
    condition: "SELLABLE" | "DAMAGED" | "QUARANTINE" = "SELLABLE",
    restock = condition === "SELLABLE"
  ) =>
    returnService.createReturn(base.company.id, base.user.id, {
      invoiceId: invoice.id,
      lines: [{ invoiceLineId, quantity, condition, restock }],
    } as Parameters<typeof returnService.createReturn>[2]);

  /** ON HAND — everything owned here, in any condition. */
  const level = () =>
    stockService
      .getStockLevel(base.company.id, base.product.id, base.location.id)
      .then(Number);

  /**
   * SELLABLE — what may actually be sold (P2-2).
   *
   * These became two different numbers when statuses arrived. Damaged returns
   * now enter the ledger in the DAMAGED bucket, so on hand rises while
   * sellable does not — the goods are owned but can never fill an order.
   */
  const sellable = () =>
    availableQuantity(prisma, base.company.id, {
      productId: base.product.id,
      locationId: base.location.id,
    }).then((r) => Number(r.sellable));

  /** Raise → approve → receive, the whole happy path. */
  const receiveFlow = async (
    quantity: number,
    condition: "SELLABLE" | "DAMAGED" | "QUARANTINE" = "SELLABLE",
    restock = condition === "SELLABLE"
  ) => {
    const r = await raise(quantity, condition, restock);
    await returnService.approveReturn(base.company.id, base.user.id, r.id);
    return returnService.receiveReturn(base.company.id, base.user.id, r.id);
  };

  return {
    ...base,
    invoice,
    invoiceLineId,
    raise,
    level,
    sellable,
    receiveFlow,
  };
}

describe("sales returns — only sellable stock comes back", () => {
  beforeEach(resetDb);

  it("sellable goods increase available stock", async () => {
    const { level, receiveFlow } = await soldSetup();
    expect(await level()).toBe(90); // 100 − 10 sold

    await receiveFlow(4, "SELLABLE");
    expect(await level()).toBe(94);
  });

  it("DAMAGED goods do NOT increase sellable stock", async () => {
    // The headline rule, unchanged since P1-6: broken goods must never go
    // back on sale. What CHANGED in P2-2 is where they go instead — they now
    // enter the ledger as DAMAGED rather than vanishing, so the company owns
    // 94 while only 90 may be sold.
    const { level, sellable, receiveFlow } = await soldSetup();
    await receiveFlow(4, "DAMAGED");

    expect(await sellable()).toBe(90); // the rule that matters — unchanged
    expect(await level()).toBe(94); // but we DO own them now
  });

  it("QUARANTINE goods do NOT increase sellable stock", async () => {
    const { level, sellable, receiveFlow } = await soldSetup();
    await receiveFlow(4, "QUARANTINE");
    expect(await sellable()).toBe(90);
    expect(await level()).toBe(94);
  });

  it("damaged goods enter the ledger in the DAMAGED bucket", async () => {
    // Before P2-2 this asserted ZERO movements — damaged returns were noted
    // on the document and then disappeared: not counted, not valued, invisible
    // to a stocktake. The warehouse held goods the system denied existed.
    const { company, receiveFlow } = await soldSetup();
    const ret = await receiveFlow(4, "DAMAGED");

    expect(ret.status).toBe("RECEIVED");
    expect(ret.lines[0]!.condition).toBe("DAMAGED");
    expect(Number(ret.lines[0]!.quantity)).toBe(4);
    expect(ret.lines[0]!.restock).toBe(false);

    const movements = await prisma.stockMovement.findMany({
      where: { companyId: company.id, type: "RETURN_IN" },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]!.status).toBe("DAMAGED"); // owned, never sellable
    expect(Number(movements[0]!.quantity)).toBe(4);
  });

  it("refuses to restock damaged goods even if asked", async () => {
    const { raise } = await soldSetup();
    await expectAppError(raise(4, "DAMAGED", true), 400);
  });

  it("sellable goods CAN be declined for restock — they go to quarantine", async () => {
    // The decision is allowed in this direction — perhaps it's being written
    // off, or sent back to the supplier. Since P2-2 the goods are HELD rather
    // than vanishing: they physically came back, so pretending otherwise
    // would be the same invisibility problem in a different costume.
    const { company, product, location, level, sellable, receiveFlow } =
      await soldSetup();
    await receiveFlow(4, "SELLABLE", false);

    expect(await sellable()).toBe(90); // not back on sale
    expect(await level()).toBe(94); // but accounted for

    const rows = await stockService.stockLevels(company.id, {
      take: 50,
      skip: 0,
    } as never);
    const shelf = rows.find(
      (r) => r.product.id === product.id && r.location.id === location.id
    )!;
    expect(Number(shelf.quarantine)).toBe(4);
  });

  it("a mixed return returns only the sellable part to sale", async () => {
    const { company, user, invoice, invoiceLineId, level, sellable } =
      await soldSetup();
    const ret = await returnService.createReturn(company.id, user.id, {
      invoiceId: invoice.id,
      lines: [
        { invoiceLineId, quantity: 3, condition: "SELLABLE", restock: true },
        { invoiceLineId, quantity: 2, condition: "DAMAGED", restock: false },
      ],
    } as Parameters<typeof returnService.createReturn>[2]);
    await returnService.approveReturn(company.id, user.id, ret.id);
    await returnService.receiveReturn(company.id, user.id, ret.id);

    expect(await sellable()).toBe(93); // only the 3 good ones are back on sale
    expect(await level()).toBe(95); // all 5 are owned — 3 good, 2 damaged
  });
});

describe("sales returns — partial returns", () => {
  beforeEach(resetDb);

  it("returns part of a line, which was impossible before", async () => {
    const { level, receiveFlow } = await soldSetup();
    await receiveFlow(2);
    expect(await level()).toBe(92);
  });

  it("refuses more than was sold", async () => {
    const { raise } = await soldSetup();
    const err = await expectAppError(raise(11), 400);
    expect(err.message).toContain("sold");
  });

  it("refuses more than is LEFT to return, cumulatively", async () => {
    // The check has to span every previous return, or a customer could send
    // back 10 of 10 items three times over.
    const { raise, receiveFlow } = await soldSetup();
    await receiveFlow(6);

    const err = await expectAppError(raise(5), 400);
    expect(err.message).toContain("already returned");
  });

  it("allows exactly the remainder", async () => {
    const { level, receiveFlow } = await soldSetup();
    await receiveFlow(6);
    await receiveFlow(4); // exactly the rest
    expect(await level()).toBe(100); // all ten back
  });

  it("a cancelled return doesn't consume the returnable quantity", async () => {
    const { company, user, raise, receiveFlow } = await soldSetup();
    const abandoned = await raise(10);
    await returnService.cancelReturn(company.id, abandoned.id);

    // The full ten are returnable again.
    await receiveFlow(10);
  });

  it("reports what's still returnable", async () => {
    const { company, invoice, receiveFlow } = await soldSetup();
    await receiveFlow(3);

    const rows = await returnService.returnableFor(company.id, invoice.id);
    expect(rows[0]!.sold).toBe(10);
    expect(rows[0]!.returned).toBe(3);
    expect(rows[0]!.returnable).toBe(7);
  });
});

describe("sales returns — status flow", () => {
  beforeEach(resetDb);

  it("stock moves at RECEIVED, not at REQUESTED or APPROVED", async () => {
    // A customer SAYING they'll return something is not goods on your shelf.
    const { company, user, raise, level } = await soldSetup();
    const ret = await raise(5);
    expect(ret.status).toBe("REQUESTED");
    expect(await level()).toBe(90);

    await returnService.approveReturn(company.id, user.id, ret.id);
    expect(await level()).toBe(90); // still nothing

    await returnService.receiveReturn(company.id, user.id, ret.id);
    expect(await level()).toBe(95); // NOW
  });

  it("can't receive before approving", async () => {
    const { company, user, raise } = await soldSetup();
    const ret = await raise(5);
    await expectAppError(
      returnService.receiveReturn(company.id, user.id, ret.id),
      409
    );
  });

  it("can't refund before receiving", async () => {
    const { company, user, raise } = await soldSetup();
    const ret = await raise(5);
    await returnService.approveReturn(company.id, user.id, ret.id);
    await expectAppError(
      returnService.refundReturn(company.id, ret.id, { refundAmount: 250 }),
      409
    );
  });

  it("records the refund once the goods are back", async () => {
    const { company, receiveFlow } = await soldSetup();
    const ret = await receiveFlow(5);
    const refunded = await returnService.refundReturn(company.id, ret.id, {
      refundAmount: 250,
    });
    expect(refunded.status).toBe("REFUNDED");
    expect(Number(refunded.refundAmount)).toBe(250);
    expect(refunded.refundedAt).not.toBeNull();
  });

  it("can't cancel once the goods are physically back", async () => {
    const { company, receiveFlow } = await soldSetup();
    const ret = await receiveFlow(5);
    const err = await expectAppError(
      returnService.cancelReturn(company.id, ret.id),
      409
    );
    expect(err.message).toContain("adjustment");
  });

  it("records who did what", async () => {
    const { company, user, receiveFlow } = await soldSetup();
    const ret = await receiveFlow(5);
    expect(ret.requestedBy.id).toBe(user.id);
    expect(ret.approvedBy?.id).toBe(user.id);
    expect(ret.receivedBy?.id).toBe(user.id);
    expect(ret.approvedAt).not.toBeNull();
    expect(ret.receivedAt).not.toBeNull();
  });
});

describe("sales returns — invoice rules", () => {
  beforeEach(resetDb);

  it("can't return against a DRAFT invoice", async () => {
    const base = await createTestCompany();
    const draft = await invService.createInvoice(base.company.id, base.user.id, {
      customerName: "Walk-in",
      locationId: base.location.id,
      lines: [{ productId: base.product.id, quantity: 1, unitPrice: 10 }],
    } as Parameters<typeof invService.createInvoice>[2]);
    const full = await invService.getInvoice(base.company.id, draft.id);

    await expectAppError(
      returnService.createReturn(base.company.id, base.user.id, {
        invoiceId: draft.id,
        lines: [
          {
            invoiceLineId: full.lines[0]!.id,
            quantity: 1,
            condition: "SELLABLE",
            restock: true,
          },
        ],
      } as Parameters<typeof returnService.createReturn>[2]),
      409
    );
  });

  it("can't return against a CANCELLED invoice", async () => {
    // Cancelling already restored the stock — returning again would
    // double-count it.
    const { company, user, invoice, invoiceLineId } = await soldSetup();
    await invService.cancelInvoice(company.id, user.id, invoice.id);

    await expectAppError(
      returnService.createReturn(company.id, user.id, {
        invoiceId: invoice.id,
        lines: [
          {
            invoiceLineId,
            quantity: 1,
            condition: "SELLABLE",
            restock: true,
          },
        ],
      } as Parameters<typeof returnService.createReturn>[2]),
      409
    );
  });

  it("rejects an item that isn't on the invoice", async () => {
    const { company, user, invoice } = await soldSetup();
    await expectAppError(
      returnService.createReturn(company.id, user.id, {
        invoiceId: invoice.id,
        lines: [
          {
            invoiceLineId: "not-a-real-line",
            quantity: 1,
            condition: "SELLABLE",
            restock: true,
          },
        ],
      } as Parameters<typeof returnService.createReturn>[2]),
      400
    );
  });

  it("a rejected line leaves NO return document behind", async () => {
    const { company, user, invoice, invoiceLineId } = await soldSetup();
    await expectAppError(
      returnService.createReturn(company.id, user.id, {
        invoiceId: invoice.id,
        lines: [
          { invoiceLineId, quantity: 2, condition: "SELLABLE", restock: true },
          { invoiceLineId, quantity: 99, condition: "SELLABLE", restock: true },
        ],
      } as Parameters<typeof returnService.createReturn>[2]),
      400
    );
    expect(await prisma.salesReturn.count()).toBe(0);
    expect(await prisma.salesReturnLine.count()).toBe(0);
  });
});

describe("sales returns — costing", () => {
  beforeEach(resetDb);

  it("returned stock comes back at the cost it left at", async () => {
    // Not today's average — otherwise a return after a dearer purchase would
    // conjure value out of a customer's change of mind.
    const { company, user, product, location, receiveFlow } = await soldSetup();

    // A dearer delivery moves the average AFTER the sale.
    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "PURCHASE",
      quantity: 100,
      unitCost: 80,
    } as Parameters<typeof stockService.createMovement>[2]);

    await receiveFlow(5);

    const returnIn = await prisma.stockMovement.findFirst({
      where: { companyId: company.id, type: "RETURN_IN" },
    });
    expect(returnIn!.costAtTime!.toString()).toBe("20"); // NOT the new average
  });

  it("per-company numbering starts at 1", async () => {
    const { company, receiveFlow } = await soldSetup();
    const ret = await receiveFlow(1);
    expect(ret.number).toBe(1);
    expect(returnService.retRef(ret.number)).toBe("RET-0001");
    void company;
  });
});

describe("sales returns — concurrency", () => {
  beforeEach(resetDb);

  it("two simultaneous returns cannot together exceed what was sold", async () => {
    // Read already-returned → check → insert is the oversell shape again.
    const { raise } = await soldSetup();

    const results = await Promise.allSettled([raise(6), raise(6)]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(1); // 6 + 6 > 10

    const lines = await prisma.salesReturnLine.aggregate({
      _sum: { quantity: true },
    });
    expect(Number(lines._sum.quantity)).toBe(6);
  });
});
