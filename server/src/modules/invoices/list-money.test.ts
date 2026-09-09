/**
 * The invoice LIST must agree with the invoice (BUG-12 and BUG-13).
 *
 * Both found by clicking through the live site:
 *
 *   BUG-12 — every GST invoice showed ₹0 in the list while its own detail page
 *   showed ₹210. `listInvoices` selected only quantity and unitPrice, so the
 *   GST branch of invoiceTotalDecimal summed a row of nulls. The comment above
 *   it described the correct behaviour the whole time; the query never fetched
 *   the columns the comment was talking about.
 *
 *   BUG-13 — an invoice sat in the list as PAID with no payments against it,
 *   and appeared simultaneously in the outstanding-balances report owing ₹59.
 *   The list showed `Invoice.status`, a workflow flag that only moves when
 *   someone acts, while every money figure is derived from the payment rows.
 *
 * The property under test in both cases is the same: a figure shown in a list
 * and the same figure shown on the record must not be able to disagree.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import * as invService from "./inv.service.js";
import * as stockService from "../stock/stock.service.js";
import * as paymentService from "../payments/payment.service.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";

async function shop() {
  const base = await createTestCompany();

  await prisma.company.update({
    where: { id: base.company.id },
    data: { stateCode: "08", gstin: "08AAAAA0000A1Z5" },
  });
  await prisma.product.update({
    where: { id: base.product.id },
    data: {
      gstRate: 5,
      sellingPrice: 80,
      // Sold by weight, so the 2.5 below is a legal quantity.
      unit: "kg",
      precision: 3,
    },
  });

  await stockService.createMovement(base.company.id, base.user.id, {
    productId: base.product.id,
    locationId: base.location.id,
    type: "PURCHASE",
    quantity: 500,
    unitCost: 50,
  } as Parameters<typeof stockService.createMovement>[2]);

  const raise = async (useGst: boolean, quantity = 2.5) => {
    const draft = await invService.createInvoice(base.company.id, base.user.id, {
      customerName: "Walk-in",
      locationId: base.location.id,
      useGst,
      ...(useGst ? { placeOfSupply: "08" } : {}),
      lines: [
        { productId: base.product.id, quantity, unitPrice: 80 },
      ],
    } as Parameters<typeof invService.createInvoice>[2]);
    await invService.issueInvoice(base.company.id, base.user.id, draft.id);
    return draft.id;
  };

  const row = async (id: string) => {
    const list = await invService.listInvoices(base.company.id, {
      take: 50,
      skip: 0,
    } as Parameters<typeof invService.listInvoices>[1]);
    return list.items.find((r) => r.id === id)!;
  };

  return { ...base, raise, row };
}

describe("invoice list — money agrees with the invoice", () => {
  beforeEach(resetDb);

  it("THE BUG: a GST invoice's list total is not zero", async () => {
    const { company, raise, row } = await shop();
    const id = await raise(true);

    const detail = await invService.getInvoice(company.id, id);
    const listed = await row(id);

    expect(Number(detail.totalAmount)).toBe(210);
    expect(listed.total).toBe(Number(detail.totalAmount));
  });

  it("a flat-rate invoice's list total still matches", async () => {
    // The case that always worked — kept so a fix to the GST branch can't
    // quietly break the other one.
    const { company, raise, row } = await shop();
    const id = await raise(false);

    const detail = await invService.getInvoice(company.id, id);
    expect((await row(id)).total).toBe(Number(detail.totalAmount));
  });

  it("THE OTHER BUG: the list reports what the PAYMENTS say, not the flag", async () => {
    // Force the exact drift found live: status PAID, nothing ever received.
    const { company, raise, row } = await shop();
    const id = await raise(true);
    await prisma.invoice.update({ where: { id }, data: { status: "PAID" } });

    const listed = await row(id);
    expect(listed.paymentStatus).toBe("UNPAID");
    expect(listed.balance).toBe(210);

    // The document flag is untouched — it answers a different question, and
    // rewriting history to make a display consistent would be the worse fix.
    expect(listed.status).toBe("PAID");
  });

  it("paying the invoice moves the derived status, in list and detail alike", async () => {
    const { company, user, raise, row } = await shop();
    const id = await raise(true);

    await paymentService.recordPayment(company.id, user.id, {
      invoiceId: id,
      amount: 100,
      method: "CASH",
    } as Parameters<typeof paymentService.recordPayment>[2]);

    let listed = await row(id);
    let detail = await invService.getInvoice(company.id, id);
    expect(listed.paymentStatus).toBe("PARTIAL");
    expect(listed.paymentStatus).toBe(detail.paymentStatus);
    expect(listed.balance).toBe(Number(detail.balanceAmount));

    await paymentService.recordPayment(company.id, user.id, {
      invoiceId: id,
      amount: 110,
      method: "CASH",
    } as Parameters<typeof paymentService.recordPayment>[2]);

    listed = await row(id);
    detail = await invService.getInvoice(company.id, id);
    expect(listed.paymentStatus).toBe("PAID");
    expect(listed.balance).toBe(0);
    expect(listed.balance).toBe(Number(detail.balanceAmount));
  });

  it("a draft stays a draft whatever the money says", async () => {
    // DRAFT and CANCELLED describe the DOCUMENT. No payment figure overrides
    // them, which is why the badge helper keeps them separate.
    const { company, user, product, location } = await shop();
    const draft = await invService.createInvoice(company.id, user.id, {
      customerName: "Walk-in",
      locationId: location.id,
      lines: [{ productId: product.id, quantity: 1, unitPrice: 80 }],
    } as Parameters<typeof invService.createInvoice>[2]);

    const list = await invService.listInvoices(company.id, {
      take: 50,
      skip: 0,
    } as Parameters<typeof invService.listInvoices>[1]);
    const row = list.items.find((r) => r.id === draft.id)!;
    expect(row.status).toBe("DRAFT");
  });

  it("the list nets returns the same way the invoice does", async () => {
    // Two screens, one set of return records — they must not diverge.
    const { company, user, raise, row } = await shop();
    const id = await raise(true);
    await paymentService.recordPayment(company.id, user.id, {
      invoiceId: id,
      amount: 210,
      method: "CASH",
    } as Parameters<typeof paymentService.recordPayment>[2]);

    const detail = await invService.getInvoice(company.id, id);
    const listed = await row(id);
    expect(listed.netTotal).toBe(Number(detail.netTotalAmount));
    expect(listed.balance).toBe(Number(detail.balanceAmount));
  });
});
