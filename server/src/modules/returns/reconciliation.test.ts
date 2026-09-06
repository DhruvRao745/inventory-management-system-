/**
 * Sales-return reconciliation, end to end (BUG-3).
 *
 * The bug was not in any one screen. A return moved stock and recorded a
 * refund, and nothing else read it: the invoice never mentioned it, the
 * balance ignored the refund, and revenue, COGS and profit stayed gross. The
 * same units were simultaneously back on the shelf and still sold.
 *
 * So these tests assert AGREEMENT, not individual numbers. Each one checks the
 * invoice, the money and the ledger together, because a fix that satisfies one
 * of the three and not the others is the bug wearing a different hat.
 *
 * Fixture: 100 units bought at ₹20, 10 sold at ₹50 on INV-0001.
 *   gross sale  10 × 50 = 500
 *   gross COGS  10 × 20 = 200
 *   gross profit        = 300
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import * as returnService from "./return.service.js";
import * as invService from "../invoices/inv.service.js";
import * as stockService from "../stock/stock.service.js";
import * as paymentService from "../payments/payment.service.js";
import { availableQuantity } from "../../lib/reservations.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";

const COST = 20;
const PRICE = 50;

async function soldSetup() {
  const base = await createTestCompany();

  await stockService.createMovement(base.company.id, base.user.id, {
    productId: base.product.id,
    locationId: base.location.id,
    type: "PURCHASE",
    quantity: 100,
    unitCost: COST,
  } as Parameters<typeof stockService.createMovement>[2]);

  const invoice = await invService.createInvoice(base.company.id, base.user.id, {
    customerName: "Ravi Kumar",
    locationId: base.location.id,
    lines: [{ productId: base.product.id, quantity: 10, unitPrice: PRICE }],
  } as Parameters<typeof invService.createInvoice>[2]);
  await invService.issueInvoice(base.company.id, base.user.id, invoice.id);

  const issued = await invService.getInvoice(base.company.id, invoice.id);
  const invoiceLineId = issued.lines[0]!.id;

  /** Raise → approve → receive, optionally refund. */
  const returnGoods = async (
    quantity: number,
    opts: {
      condition?: "SELLABLE" | "DAMAGED" | "QUARANTINE";
      refund?: number;
    } = {}
  ) => {
    const condition = opts.condition ?? "SELLABLE";
    const r = await returnService.createReturn(base.company.id, base.user.id, {
      invoiceId: invoice.id,
      lines: [
        {
          invoiceLineId,
          quantity,
          condition,
          restock: condition === "SELLABLE",
        },
      ],
    } as Parameters<typeof returnService.createReturn>[2]);
    await returnService.approveReturn(base.company.id, base.user.id, r.id);
    const received = await returnService.receiveReturn(
      base.company.id,
      base.user.id,
      r.id
    );
    if (opts.refund === undefined) return received;
    return returnService.refundReturn(base.company.id, r.id, {
      refundAmount: opts.refund,
    });
  };

  const reload = () => invService.getInvoice(base.company.id, invoice.id);

  /** Revenue, COGS and profit the way the profitability report computes them. */
  const profitability = async () => {
    const sales = await prisma.stockMovement.findMany({
      where: { companyId: base.company.id, type: "SALE" },
      select: { quantity: true, costAtTime: true },
    });
    const returns = await prisma.stockMovement.findMany({
      where: { companyId: base.company.id, type: "RETURN_IN" },
      select: { quantity: true, costAtTime: true },
    });
    const cogs =
      sales.reduce(
        (s, m) => s + Math.abs(Number(m.quantity)) * Number(m.costAtTime ?? 0),
        0
      ) -
      returns.reduce(
        (s, m) => s + Math.abs(Number(m.quantity)) * Number(m.costAtTime ?? 0),
        0
      );
    const inv = await reload();
    const revenue = Number(inv.netTotalAmount);
    return { revenue, cogs, grossProfit: revenue - cogs };
  };

  const onHand = () =>
    stockService
      .getStockLevel(base.company.id, base.product.id, base.location.id)
      .then(Number);

  const sellable = () =>
    availableQuantity(prisma, base.company.id, {
      productId: base.product.id,
      locationId: base.location.id,
    }).then((r) => Number(r.sellable));

  const pay = (amount: number) =>
    paymentService.recordPayment(base.company.id, base.user.id, {
      invoiceId: invoice.id,
      amount,
      method: "CASH",
    } as Parameters<typeof paymentService.recordPayment>[2]);

  return {
    ...base,
    invoice,
    invoiceLineId,
    returnGoods,
    reload,
    profitability,
    onHand,
    sellable,
    pay,
  };
}

describe("sales-return reconciliation", () => {
  beforeEach(resetDb);

  it("no return: net figures equal gross figures", async () => {
    // The control case. If netting is wrong, it is usually wrong here first.
    const { reload, profitability, onHand } = await soldSetup();

    const inv = await reload();
    expect(Number(inv.totalAmount)).toBe(500);
    expect(Number(inv.returnedAmount)).toBe(0);
    expect(Number(inv.netTotalAmount)).toBe(500);
    expect(Number(inv.returned.quantity)).toBe(0);
    expect(inv.returned.fullyReturned).toBe(false);

    const p = await profitability();
    expect(p).toEqual({ revenue: 500, cogs: 200, grossProfit: 300 });
    expect(await onHand()).toBe(90);
  });

  it("partial return + refund: invoice, balance and stock all agree", async () => {
    // The reported case: 5 back, ₹250 refunded on a ₹500 invoice.
    const { returnGoods, reload, pay, onHand, sellable } = await soldSetup();
    await pay(500); // customer had paid in full

    await returnGoods(5, { refund: 250 });

    const inv = await reload();
    // History is intact...
    expect(Number(inv.totalAmount)).toBe(500);
    expect(Number(inv.paidAmount)).toBe(500);
    // ...and the net position is right.
    expect(Number(inv.returnedAmount)).toBe(250);
    expect(Number(inv.refundedAmount)).toBe(250);
    expect(Number(inv.netTotalAmount)).toBe(250);
    expect(Number(inv.netPaidAmount)).toBe(250);
    expect(Number(inv.balanceAmount)).toBe(0);
    expect(inv.paymentStatus).toBe("PAID");

    // The line knows what it kept.
    expect(Number(inv.lines[0]!.returnedQuantity)).toBe(5);
    expect(Number(inv.lines[0]!.netQuantity)).toBe(5);
    expect(Number(inv.lines[0]!.netLineTotal)).toBe(250);

    // And the goods really are back.
    expect(await onHand()).toBe(95);
    expect(await sellable()).toBe(95);
  });

  it("partial return with DAMAGED goods: value reverses, sellable stock does not", async () => {
    // The case where money and stock legitimately disagree — and must still
    // both be right. We owe the customer for goods we can never resell.
    const { returnGoods, reload, onHand, sellable } = await soldSetup();

    await returnGoods(4, { condition: "DAMAGED", refund: 200 });

    const inv = await reload();
    expect(Number(inv.returnedAmount)).toBe(200);
    expect(Number(inv.netTotalAmount)).toBe(300);
    expect(Number(inv.returned.byCondition.DAMAGED)).toBe(4);
    expect(Number(inv.returned.byCondition.SELLABLE)).toBe(0);

    // Owned: 94. Sellable: still 90 — damage doesn't go back on sale.
    expect(await onHand()).toBe(94);
    expect(await sellable()).toBe(90);
  });

  it("quarantined returns are owned but not sellable, and still reverse the sale", async () => {
    const { returnGoods, reload, onHand, sellable } = await soldSetup();

    await returnGoods(2, { condition: "QUARANTINE" });

    const inv = await reload();
    expect(Number(inv.returnedAmount)).toBe(100);
    expect(Number(inv.returned.byCondition.QUARANTINE)).toBe(2);
    expect(await onHand()).toBe(92);
    expect(await sellable()).toBe(90);
  });

  it("multiple partial returns accumulate", async () => {
    const { returnGoods, reload, onHand } = await soldSetup();

    await returnGoods(3, { refund: 150 });
    await returnGoods(2, { refund: 100 });

    const inv = await reload();
    expect(Number(inv.returned.quantity)).toBe(5);
    expect(Number(inv.returnedAmount)).toBe(250);
    expect(Number(inv.refundedAmount)).toBe(250);
    expect(Number(inv.netTotalAmount)).toBe(250);
    expect(Number(inv.lines[0]!.netQuantity)).toBe(5);
    expect(inv.returned.fullyReturned).toBe(false);
    expect(await onHand()).toBe(95);
  });

  it("full return: net sale is zero and nothing is owed either way", async () => {
    const { returnGoods, reload, pay, profitability, onHand } =
      await soldSetup();
    await pay(500);

    await returnGoods(10, { refund: 500 });

    const inv = await reload();
    expect(Number(inv.netTotalAmount)).toBe(0);
    expect(Number(inv.netPaidAmount)).toBe(0);
    expect(Number(inv.balanceAmount)).toBe(0);
    expect(Number(inv.lines[0]!.netQuantity)).toBe(0);
    expect(inv.returned.fullyReturned).toBe(true);

    // Every unit is back and the profit from the sale is gone with it.
    expect(await onHand()).toBe(100);
    const p = await profitability();
    expect(p).toEqual({ revenue: 0, cogs: 0, grossProfit: 0 });
  });

  it("COGS and profit reverse at the cost the goods LEFT at", async () => {
    // The costing trap: goods bought later at a higher price must not change
    // what an earlier sale cost. Returning 5 must remove exactly 5 × 20.
    const { company, user, product, location, returnGoods, profitability } =
      await soldSetup();

    // A dearer delivery lands AFTER the sale, moving the weighted average.
    await stockService.createMovement(company.id, user.id, {
      productId: product.id,
      locationId: location.id,
      type: "PURCHASE",
      quantity: 100,
      unitCost: 60,
    } as Parameters<typeof stockService.createMovement>[2]);

    await returnGoods(5, { refund: 250 });

    const p = await profitability();
    expect(p.revenue).toBe(250); // 500 − 250
    expect(p.cogs).toBe(100); // 200 − (5 × 20), NOT 5 × the new average
    expect(p.grossProfit).toBe(150);

    const returnMovement = await prisma.stockMovement.findFirstOrThrow({
      where: { companyId: company.id, type: "RETURN_IN" },
    });
    expect(Number(returnMovement.costAtTime)).toBe(COST);
  });

  it("an unpaid invoice with a return leaves only the kept goods owing", async () => {
    // Nothing was paid and nothing refunded, so the customer owes for what
    // they kept — and can no longer be billed for what they sent back.
    const { returnGoods, reload } = await soldSetup();

    await returnGoods(6);

    const inv = await reload();
    expect(Number(inv.paidAmount)).toBe(0);
    expect(Number(inv.netTotalAmount)).toBe(200);
    expect(Number(inv.balanceAmount)).toBe(200);
    expect(inv.paymentStatus).toBe("UNPAID");
  });

  it("a paid invoice with an unrefunded return shows a NEGATIVE balance — we owe them", async () => {
    // Silence here was the worst outcome: the customer's money sits with us
    // and no screen says so.
    const { returnGoods, reload, pay } = await soldSetup();
    await pay(500);

    await returnGoods(4); // received, not yet refunded

    const inv = await reload();
    expect(Number(inv.netTotalAmount)).toBe(300);
    expect(Number(inv.netPaidAmount)).toBe(500);
    expect(Number(inv.balanceAmount)).toBe(-200);
  });

  it("payment is capped at the NET balance after a return", async () => {
    const { returnGoods, pay, reload } = await soldSetup();
    await returnGoods(5, { refund: 0 });

    // Only ₹250 of goods were kept, so ₹500 may no longer be collected.
    await expect(pay(500)).rejects.toThrow();

    await pay(250);
    const inv = await reload();
    expect(Number(inv.balanceAmount)).toBe(0);
    expect(inv.paymentStatus).toBe("PAID");
  });

  it("outstanding balances report agrees with the invoice", async () => {
    const { company, returnGoods, reload } = await soldSetup();
    await returnGoods(6);

    const inv = await reload();
    const report = await paymentService.outstandingBalances(company.id);
    const row = report.rows.find((r) => r.invoiceId === inv.id)!;

    expect(row.balanceAmount).toBe(Number(inv.balanceAmount));
    expect(row.netTotalAmount).toBe(Number(inv.netTotalAmount));
    expect(report.totalOutstanding).toBe(200);
  });

  it("a REQUESTED return does not reverse anything yet", async () => {
    // Goods are still at the customer's house. Reversing the sale now would
    // report it as undone while nothing has moved — and the ledger, which
    // only moves at RECEIVED, would disagree with the money.
    const { company, user, invoice, invoiceLineId, reload, onHand } =
      await soldSetup();

    await returnService.createReturn(company.id, user.id, {
      invoiceId: invoice.id,
      lines: [
        { invoiceLineId, quantity: 5, condition: "SELLABLE", restock: true },
      ],
    } as Parameters<typeof returnService.createReturn>[2]);

    const inv = await reload();
    expect(Number(inv.returnedAmount)).toBe(0);
    expect(Number(inv.netTotalAmount)).toBe(500);
    expect(await onHand()).toBe(90);
  });
});
