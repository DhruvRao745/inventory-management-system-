/**
 * GST on real invoices (P2-3).
 *
 * The rule these defend, and the reason the whole feature is shaped the way it
 * is: AN ISSUED INVOICE IS A LEGAL DOCUMENT. Its tax is computed once, stamped
 * onto its lines, and read back forever after. It is never recomputed.
 *
 * If tax were derived on read, then changing a product's rate — or the
 * company's state, or a customer's address — would silently rewrite every
 * invoice ever issued. The copy in the customer's filing cabinet would stop
 * matching ours, and neither of us could prove which was right.
 *
 * This is the same principle as `costAtTime` in P1-3, applied to tax.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import * as invService from "./inv.service.js";
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

/** A Maharashtra company with stock and an 18% product. */
async function gstShop(sellerState = "27") {
  const base = await createTestCompany();
  await prisma.company.update({
    where: { id: base.company.id },
    data: { stateCode: sellerState, gstin: `${sellerState}AAPFU0939F1ZV` },
  });
  await prisma.product.update({
    where: { id: base.product.id },
    data: { gstRate: 18, hsnCode: "8471" },
  });
  await stockService.createMovement(base.company.id, base.user.id, {
    productId: base.product.id,
    locationId: base.location.id,
    type: "PURCHASE",
    quantity: 100,
    unitCost: 10,
  } as Parameters<typeof stockService.createMovement>[2]);

  const raise = (extra: Record<string, unknown> = {}, qty = 1, price = 1000) =>
    invService.createInvoice(base.company.id, base.user.id, {
      customerName: "Walk-in",
      locationId: base.location.id,
      useGst: true,
      lines: [{ productId: base.product.id, quantity: qty, unitPrice: price }],
      ...extra,
    } as Parameters<typeof invService.createInvoice>[2]);

  return { ...base, raise };
}

describe("GST invoices — the split follows the customer", () => {
  beforeEach(resetDb);

  it("a sale in the seller's own state is CGST + SGST", async () => {
    const { company, raise } = await gstShop("27");
    const inv = await raise({ placeOfSupply: "27" });
    const full = await invService.getInvoice(company.id, inv.id);

    expect(full.supplyType).toBe("INTRA_STATE");
    expect(Number(full.gst!.cgstAmount)).toBe(90);
    expect(Number(full.gst!.sgstAmount)).toBe(90);
    expect(Number(full.gst!.igstAmount)).toBe(0);
    expect(Number(full.totalAmount)).toBe(1180);
  });

  it("a sale to another state is IGST", async () => {
    const { company, raise } = await gstShop("27");
    const inv = await raise({ placeOfSupply: "29" }); // Karnataka
    const full = await invService.getInvoice(company.id, inv.id);

    expect(full.supplyType).toBe("INTER_STATE");
    expect(Number(full.gst!.igstAmount)).toBe(180);
    expect(Number(full.gst!.cgstAmount)).toBe(0);
    expect(Number(full.totalAmount)).toBe(1180); // same total, different split
  });

  it("takes the place of supply from the buyer's GSTIN when not given", async () => {
    const { company, raise } = await gstShop("27");
    const inv = await raise({ customerGstin: "29AAPFU0939F1ZV" });
    const full = await invService.getInvoice(company.id, inv.id);

    expect(full.placeOfSupply).toBe("29");
    expect(full.supplyType).toBe("INTER_STATE");
  });

  it("takes it from a linked customer's state", async () => {
    const { company, user, location, product } = await gstShop("27");
    const customer = await prisma.customer.create({
      data: { companyId: company.id, name: "Bengaluru Traders", stateCode: "29" },
    });

    const inv = await invService.createInvoice(company.id, user.id, {
      customerName: customer.name,
      customerId: customer.id,
      locationId: location.id,
      useGst: true,
      lines: [{ productId: product.id, quantity: 1, unitPrice: 1000 }],
    } as Parameters<typeof invService.createInvoice>[2]);

    const full = await invService.getInvoice(company.id, inv.id);
    expect(full.placeOfSupply).toBe("29");
    expect(full.supplyType).toBe("INTER_STATE");
  });

  it("a walk-in with no address is treated as a local sale", async () => {
    const { company, raise } = await gstShop("27");
    const inv = await raise();
    const full = await invService.getInvoice(company.id, inv.id);
    expect(full.supplyType).toBe("INTRA_STATE");
  });

  it("refuses GST invoicing when the company has no state set", async () => {
    // Without it there is no way to tell intra- from inter-state, and guessing
    // would report money to the wrong government.
    const base = await createTestCompany();
    await stockService.createMovement(base.company.id, base.user.id, {
      productId: base.product.id,
      locationId: base.location.id,
      type: "PURCHASE",
      quantity: 10,
      unitCost: 10,
    } as Parameters<typeof stockService.createMovement>[2]);

    const err = await expectAppError(
      invService.createInvoice(base.company.id, base.user.id, {
        customerName: "Walk-in",
        locationId: base.location.id,
        useGst: true,
        lines: [{ productId: base.product.id, quantity: 1, unitPrice: 100 }],
      } as Parameters<typeof invService.createInvoice>[2]),
      400
    );
    expect(err.message).toMatch(/state/i);
  });
});

describe("GST invoices — tax is STAMPED, never recomputed", () => {
  beforeEach(resetDb);

  it("changing the product rate does NOT change an issued invoice", async () => {
    // THE test. An invoice raised at 18% must still read 18% after the
    // government moves the rate to 28% — otherwise the customer's copy and
    // ours stop agreeing, and financial history rewrites itself silently.
    const { company, user, product, raise } = await gstShop("27");
    const inv = await raise({ placeOfSupply: "27" });
    await invService.issueInvoice(company.id, user.id, inv.id);

    const before = await invService.getInvoice(company.id, inv.id);
    expect(Number(before.totalAmount)).toBe(1180);

    // The rate changes for everything sold from now on.
    await prisma.product.update({
      where: { id: product.id },
      data: { gstRate: 28 },
    });

    const after = await invService.getInvoice(company.id, inv.id);
    expect(Number(after.totalAmount)).toBe(1180); // unchanged
    expect(Number(after.gst!.cgstAmount)).toBe(90);
    expect(Number(after.lines[0]!.gstRate)).toBe(18);
  });

  it("moving the company to another state does NOT re-split an issued invoice", async () => {
    const { company, user, raise } = await gstShop("27");
    const inv = await raise({ placeOfSupply: "27" }); // intra-state
    await invService.issueInvoice(company.id, user.id, inv.id);

    await prisma.company.update({
      where: { id: company.id },
      data: { stateCode: "29" },
    });

    const after = await invService.getInvoice(company.id, inv.id);
    expect(after.supplyType).toBe("INTRA_STATE"); // as it was on the day
    expect(Number(after.gst!.cgstAmount)).toBe(90);
    expect(Number(after.gst!.igstAmount)).toBe(0);
  });

  it("stamps HSN onto the line at write time", async () => {
    const { company, product, raise } = await gstShop("27");
    const inv = await raise();

    await prisma.product.update({
      where: { id: product.id },
      data: { hsnCode: "9999" },
    });

    const full = await invService.getInvoice(company.id, inv.id);
    expect(full.lines[0]!.hsnCode).toBe("8471"); // the code as it was
  });

  it("a per-line rate override beats the product's rate", async () => {
    const { company, user, location, product } = await gstShop("27");
    const inv = await invService.createInvoice(company.id, user.id, {
      customerName: "Walk-in",
      locationId: location.id,
      useGst: true,
      lines: [
        { productId: product.id, quantity: 1, unitPrice: 1000, gstRate: 5 },
      ],
    } as Parameters<typeof invService.createInvoice>[2]);

    const full = await invService.getInvoice(company.id, inv.id);
    expect(Number(full.lines[0]!.gstRate)).toBe(5);
    expect(Number(full.gst!.totalTax)).toBe(50);
  });

  it("editing a DRAFT re-stamps the tax", async () => {
    // Allowed only because nothing has been issued — no document has left the
    // building, so no legal record is being rewritten.
    const { company, product, raise } = await gstShop("27");
    const inv = await raise({}, 1, 1000);

    await invService.updateInvoice(company.id, inv.id, {
      lines: [{ productId: product.id, quantity: 2, unitPrice: 1000 }],
    } as Parameters<typeof invService.updateInvoice>[2]);

    const full = await invService.getInvoice(company.id, inv.id);
    expect(Number(full.gst!.taxableValue)).toBe(2000);
    expect(Number(full.gst!.totalTax)).toBe(360);
  });
});

describe("GST invoices — legacy invoices are frozen", () => {
  beforeEach(resetDb);

  it("an invoice raised without GST keeps the flat-rate calculation", async () => {
    const { company, user, location, product } = await gstShop("27");
    const inv = await invService.createInvoice(company.id, user.id, {
      customerName: "Walk-in",
      locationId: location.id,
      taxRate: 10, // the old whole-invoice rate
      lines: [{ productId: product.id, quantity: 1, unitPrice: 1000 }],
    } as Parameters<typeof invService.createInvoice>[2]);

    const full = await invService.getInvoice(company.id, inv.id);
    expect(full.taxMode).toBe("FLAT");
    expect(full.gst).toBeNull(); // no GST breakdown to show
    expect(Number(full.totalAmount)).toBe(1100); // 1000 + 10%
  });

  it("a nil-rated GST invoice is not mistaken for a legacy one", async () => {
    // "No GST columns" and "GST of zero" look identical on the wire without
    // taxMode. A nil-rated invoice is a real thing and must stay a GST invoice.
    const { company, user, location, product } = await gstShop("27");
    await prisma.product.update({
      where: { id: product.id },
      data: { gstRate: 0 },
    });

    const inv = await invService.createInvoice(company.id, user.id, {
      customerName: "Walk-in",
      locationId: location.id,
      useGst: true,
      lines: [{ productId: product.id, quantity: 1, unitPrice: 1000 }],
    } as Parameters<typeof invService.createInvoice>[2]);

    const full = await invService.getInvoice(company.id, inv.id);
    expect(full.taxMode).toBe("GST");
    expect(full.gst).not.toBeNull();
    expect(Number(full.gst!.totalTax)).toBe(0);
    expect(Number(full.totalAmount)).toBe(1000);
  });

  it("payments settle a GST invoice against its stamped total", async () => {
    // The sharpest consequence of recomputing: an invoice paid in full could
    // develop an outstanding balance months later if rates moved.
    const { company, user, product, raise } = await gstShop("27");
    const inv = await raise({ placeOfSupply: "27" });
    await invService.issueInvoice(company.id, user.id, inv.id);

    const { recordPayment } = await import("../payments/payment.service.js");
    await recordPayment(company.id, user.id, {
      invoiceId: inv.id,
      amount: 1180,
      method: "CASH",
    } as Parameters<typeof recordPayment>[2]);

    await prisma.product.update({
      where: { id: product.id },
      data: { gstRate: 28 },
    });

    const full = await invService.getInvoice(company.id, inv.id);
    expect(Number(full.balanceAmount)).toBe(0); // still settled
    expect(full.paymentStatus).toBe("PAID");
  });
});
