/**
 * Payments (P1-5).
 *
 * The rule under test (PRD §8): "Do not infer payment state only from a status
 * field." Before this, "paid" was a flag someone flipped — no record of how
 * much arrived, when, or by what means, and a half-paid invoice could not be
 * represented at all.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import * as paymentService from "./payment.service.js";
import * as invService from "../invoices/inv.service.js";
import * as stockService from "../stock/stock.service.js";
import { summarisePayments } from "../../lib/money.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";

const D = (v: string | number) => new Prisma.Decimal(v);

async function expectAppError(promise: Promise<unknown>, statusCode: number) {
  const err = await promise.then(
    () => null,
    (e) => e
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).statusCode).toBe(statusCode);
  return err as AppError;
}

/** An issued ₹1,000 invoice: 10 units at ₹100, no tax, no discount. */
async function issuedInvoice(unitPrice = 100, quantity = 10) {
  const base = await createTestCompany();
  await stockService.createMovement(base.company.id, base.user.id, {
    productId: base.product.id,
    locationId: base.location.id,
    type: "PURCHASE",
    quantity: 100,
    unitCost: 50,
  } as Parameters<typeof stockService.createMovement>[2]);

  const inv = await invService.createInvoice(base.company.id, base.user.id, {
    customerName: "Ravi Kumar",
    locationId: base.location.id,
    lines: [{ productId: base.product.id, quantity, unitPrice }],
  } as Parameters<typeof invService.createInvoice>[2]);
  await invService.issueInvoice(base.company.id, base.user.id, inv.id);

  const pay = (amount: number, method: "CASH" | "UPI" = "CASH") =>
    paymentService.recordPayment(base.company.id, base.user.id, {
      invoiceId: inv.id,
      amount,
      method,
    } as Parameters<typeof paymentService.recordPayment>[2]);

  const summary = () => invService.getInvoice(base.company.id, inv.id);

  return { ...base, invoice: inv, pay, summary };
}

describe("payments — the four figures", () => {
  beforeEach(resetDb);

  it("a fresh invoice is UNPAID with the full balance outstanding", async () => {
    const { summary } = await issuedInvoice();
    const s = await summary();
    expect(Number(s.totalAmount)).toBe(1000);
    expect(Number(s.paidAmount)).toBe(0);
    expect(Number(s.balanceAmount)).toBe(1000);
    expect(s.paymentStatus).toBe("UNPAID");
  });

  it("a part payment gives PARTIAL and a real balance", async () => {
    // The state that simply could not be represented before P1-5.
    const { pay, summary } = await issuedInvoice();
    await pay(400);

    const s = await summary();
    expect(Number(s.paidAmount)).toBe(400);
    expect(Number(s.balanceAmount)).toBe(600);
    expect(s.paymentStatus).toBe("PARTIAL");
  });

  it("payments accumulate to PAID", async () => {
    const { pay, summary } = await issuedInvoice();
    await pay(400);
    await pay(350, "UPI");
    await pay(250);

    const s = await summary();
    expect(Number(s.paidAmount)).toBe(1000);
    expect(Number(s.balanceAmount)).toBe(0);
    expect(s.paymentStatus).toBe("PAID");
  });

  it("status follows the money, not the other way round", async () => {
    // Invoice.status is a CONSEQUENCE of payments now.
    const { company, invoice, pay } = await issuedInvoice();
    expect((await invService.getInvoice(company.id, invoice.id)).status).toBe(
      "ISSUED"
    );
    await pay(1000);
    expect((await invService.getInvoice(company.id, invoice.id)).status).toBe(
      "PAID"
    );
  });

  it("records the method and who took the money", async () => {
    const { company, user, pay } = await issuedInvoice();
    const { payment } = await pay(500, "UPI");
    expect(payment.method).toBe("UPI");
    expect(payment.createdBy.id).toBe(user.id);
    void company;
  });
});

describe("payments — overpayment validation", () => {
  beforeEach(resetDb);

  it("refuses more than the outstanding balance", async () => {
    const { pay } = await issuedInvoice();
    const err = await expectAppError(pay(1001), 400);
    expect(err.message).toContain("outstanding");
  });

  it("refuses a second payment that would tip it over", async () => {
    const { pay } = await issuedInvoice();
    await pay(700);
    await expectAppError(pay(400), 400); // 700 + 400 > 1000
  });

  it("refuses any payment once fully paid", async () => {
    const { pay } = await issuedInvoice();
    await pay(1000);
    await expectAppError(pay(1), 409);
  });

  it("exactly the balance is allowed", async () => {
    const { pay, summary } = await issuedInvoice();
    await pay(600);
    await pay(400); // exactly the remainder
    expect((await summary()).paymentStatus).toBe("PAID");
  });
});

describe("payments — invoice lifecycle rules", () => {
  beforeEach(resetDb);

  it("a DRAFT invoice can't take payment", async () => {
    // Nothing has been billed yet, so there's nothing to settle.
    const base = await createTestCompany();
    const draft = await invService.createInvoice(base.company.id, base.user.id, {
      customerName: "Walk-in",
      locationId: base.location.id,
      lines: [{ productId: base.product.id, quantity: 1, unitPrice: 10 }],
    } as Parameters<typeof invService.createInvoice>[2]);

    await expectAppError(
      paymentService.recordPayment(base.company.id, base.user.id, {
        invoiceId: draft.id,
        amount: 10,
        method: "CASH",
      } as Parameters<typeof paymentService.recordPayment>[2]),
      409
    );
  });

  it("a CANCELLED invoice can't take payment", async () => {
    const { company, user, invoice } = await issuedInvoice();
    await invService.cancelInvoice(company.id, user.id, invoice.id);
    await expectAppError(
      paymentService.recordPayment(company.id, user.id, {
        invoiceId: invoice.id,
        amount: 100,
        method: "CASH",
      } as Parameters<typeof paymentService.recordPayment>[2]),
      409
    );
  });

  it("a paid invoice can no longer be cancelled", async () => {
    const { company, user, invoice, pay } = await issuedInvoice();
    await pay(1000);
    await expectAppError(
      invService.cancelInvoice(company.id, user.id, invoice.id),
      409
    );
  });
});

describe("payments — corrections", () => {
  beforeEach(resetDb);

  it("deleting a payment un-pays the invoice", async () => {
    // A mistyped payment has to be removable, and the status must follow it
    // back down — otherwise the invoice reads PAID with no money behind it.
    const { company, pay, summary } = await issuedInvoice();
    const { payment } = await pay(1000);
    expect((await summary()).paymentStatus).toBe("PAID");

    await paymentService.deletePayment(company.id, payment.id);

    const s = await summary();
    expect(Number(s.paidAmount)).toBe(0);
    expect(s.paymentStatus).toBe("UNPAID");
    expect(s.status).toBe("ISSUED"); // back down from PAID
  });
});

describe("payments — outstanding balances", () => {
  beforeEach(resetDb);

  it("answers 'who owes us money?'", async () => {
    // The question the system previously could not answer at all.
    const { company, pay } = await issuedInvoice();
    await pay(300);

    const { rows, totalOutstanding } =
      await paymentService.outstandingBalances(company.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.customerName).toBe("Ravi Kumar");
    expect(rows[0]!.balanceAmount).toBe(700);
    expect(totalOutstanding).toBe(700);
  });

  it("fully paid invoices drop off the list", async () => {
    const { company, pay } = await issuedInvoice();
    await pay(1000);
    const { rows } = await paymentService.outstandingBalances(company.id);
    expect(rows).toHaveLength(0);
  });
});

describe("payments — concurrency", () => {
  beforeEach(resetDb);

  it("two simultaneous payments cannot together overpay", async () => {
    // Read balance → check → insert is the oversell shape again. Two people
    // recording the last ₹600 at the same moment would both see ₹600
    // outstanding and both be allowed — ₹1,200 against a ₹1,000 invoice.
    const { pay } = await issuedInvoice();
    await pay(400); // ₹600 left

    const results = await Promise.allSettled([pay(600), pay(600)]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(1);

    const total = await prisma.payment.aggregate({ _sum: { amount: true } });
    expect(Number(total._sum.amount)).toBe(1000); // never 1600
  });
});

describe("payments — summary maths (pure)", () => {
  it("classifies each state", () => {
    expect(summarisePayments(D(100), []).paymentStatus).toBe("UNPAID");
    expect(summarisePayments(D(100), [{ amount: D(40) }]).paymentStatus).toBe(
      "PARTIAL"
    );
    expect(summarisePayments(D(100), [{ amount: D(100) }]).paymentStatus).toBe(
      "PAID"
    );
    // Reported, not hidden — an overpayment is a refund the business owes.
    expect(summarisePayments(D(100), [{ amount: D(120) }]).paymentStatus).toBe(
      "OVERPAID"
    );
  });

  it("balance is total minus paid", () => {
    const s = summarisePayments(D("1000.50"), [
      { amount: D("400.25") },
      { amount: D("100.25") },
    ]);
    expect(s.paidAmount.toString()).toBe("500.5");
    expect(s.balanceAmount.toString()).toBe("500");
  });
});
