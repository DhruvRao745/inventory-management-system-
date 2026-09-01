/**
 * GST calculation (P2-3).
 *
 * Pure maths — no database. That's the point of lib/gst.ts existing separately:
 * rates and rules change by government notification, sometimes at days' notice,
 * so they must be testable and changeable without touching invoice storage.
 *
 * The idea being defended: GST is one tax collected by two governments. Within
 * your own state it splits in half (CGST to the centre, SGST to the state);
 * across state lines the whole amount goes as IGST. The TOTAL is identical
 * either way — the SPLIT is not, and getting it wrong means money reported to
 * the wrong government.
 */
import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import {
  computeLineTax,
  computeInvoiceGst,
  determineSupplyType,
  stateCodeFromGstin,
  isValidStateCode,
  isValidGstinShape,
} from "./gst.js";

const D = (n: number | string) => new Prisma.Decimal(n);

describe("GST — intra-state vs inter-state", () => {
  it("splits an intra-state sale into equal CGST and SGST", async () => {
    // Maharashtra → Maharashtra, 18% on ₹1,000 = ₹90 + ₹90.
    const tax = computeLineTax({
      taxableValue: D(1000),
      gstRate: D(18),
      supplyType: "INTRA_STATE",
    });
    expect(tax.cgstAmount.toString()).toBe("90");
    expect(tax.sgstAmount.toString()).toBe("90");
    expect(tax.igstAmount.toString()).toBe("0");
    expect(tax.totalTax.toString()).toBe("180");
  });

  it("charges the whole amount as IGST across state lines", async () => {
    // Maharashtra → Karnataka, same goods, same rate, same TOTAL — one tax.
    const tax = computeLineTax({
      taxableValue: D(1000),
      gstRate: D(18),
      supplyType: "INTER_STATE",
    });
    expect(tax.cgstAmount.toString()).toBe("0");
    expect(tax.sgstAmount.toString()).toBe("0");
    expect(tax.igstAmount.toString()).toBe("180");
    expect(tax.totalTax.toString()).toBe("180");
  });

  it("the total is identical either way — only the split differs", async () => {
    const intra = computeLineTax({
      taxableValue: D(1000),
      gstRate: D(18),
      supplyType: "INTRA_STATE",
    });
    const inter = computeLineTax({
      taxableValue: D(1000),
      gstRate: D(18),
      supplyType: "INTER_STATE",
    });
    expect(intra.totalTax.toString()).toBe(inter.totalTax.toString());
  });

  it("decides supply type by comparing seller state with place of supply", async () => {
    expect(determineSupplyType("27", "27")).toBe("INTRA_STATE");
    expect(determineSupplyType("27", "29")).toBe("INTER_STATE");
  });

  it("treats an unknown place of supply as intra-state", async () => {
    // The walk-in customer at the counter, who gave no address and is standing
    // in the seller's own state. Defaulting to INTER_STATE would put every
    // counter sale in the wrong bucket.
    expect(determineSupplyType("27", null)).toBe("INTRA_STATE");
    expect(determineSupplyType("27", undefined)).toBe("INTRA_STATE");
  });
});

describe("GST — rounding", () => {
  it("CGST and SGST always sum back to the total, odd paisa included", async () => {
    // ₹0.03 of tax cannot be halved evenly. Rounding both halves independently
    // would give 0.02 + 0.02 = 0.04, inventing a paisa the customer never owed.
    const tax = computeLineTax({
      taxableValue: D("0.17"),
      gstRate: D(18),
      supplyType: "INTRA_STATE",
    });
    expect(
      tax.cgstAmount.plus(tax.sgstAmount).toString()
    ).toBe(tax.totalTax.toString());
  });

  it("rounds per line, not on the invoice total", async () => {
    // Two lines each rounding to a half-paisa must not be summed first and
    // rounded once — the invoice has to foot line by line, or an accountant
    // finds a discrepancy nobody can explain.
    const breakup = computeInvoiceGst({
      lines: [
        { quantity: D(1), unitPrice: D("0.17"), gstRate: D(18) },
        { quantity: D(1), unitPrice: D("0.17"), gstRate: D(18) },
      ],
      sellerStateCode: "27",
      placeOfSupply: "27",
    });
    const summed = breakup.lines
      .reduce((s, l) => s.plus(l.totalTax), D(0))
      .toString();
    expect(breakup.totalTax.toString()).toBe(summed);
  });

  it("keeps fractional quantities exact", async () => {
    // 2.5 kg × ₹33.33 = ₹83.325 — as a float this is 83.32499999999999 and
    // rounds the wrong way.
    const breakup = computeInvoiceGst({
      lines: [{ quantity: D("2.5"), unitPrice: D("33.33"), gstRate: D(5) }],
      sellerStateCode: "27",
      placeOfSupply: "27",
    });
    expect(breakup.taxableValue.toString()).toBe("83.33");
  });
});

describe("GST — discounts", () => {
  it("charges tax on the discounted amount, not the full price", async () => {
    // Taxing before the discount charges the customer tax on money they never
    // paid. ₹1,000 − ₹100 = ₹900; 18% of 900 is 162, not 180.
    const breakup = computeInvoiceGst({
      lines: [{ quantity: D(1), unitPrice: D(1000), gstRate: D(18) }],
      discount: D(100),
      sellerStateCode: "27",
      placeOfSupply: "27",
    });
    expect(breakup.taxableValue.toString()).toBe("900");
    expect(breakup.totalTax.toString()).toBe("162");
    expect(breakup.grandTotal.toString()).toBe("1062");
  });

  it("spreads one invoice discount across lines in proportion to value", async () => {
    // The discount is stored per invoice but tax is charged per line, so it
    // has to be apportioned before any tax is worked out.
    const breakup = computeInvoiceGst({
      lines: [
        { quantity: D(1), unitPrice: D(300), gstRate: D(18) },
        { quantity: D(1), unitPrice: D(700), gstRate: D(18) },
      ],
      discount: D(100), // 30 / 70 split
      sellerStateCode: "27",
      placeOfSupply: "27",
    });
    expect(breakup.lines[0]!.taxableValue.toString()).toBe("270");
    expect(breakup.lines[1]!.taxableValue.toString()).toBe("630");
    expect(breakup.taxableValue.toString()).toBe("900");
  });

  it("apportioned discounts sum to exactly the discount given", async () => {
    // A ₹10 discount across three equal lines is ₹3.33 each — which sums to
    // ₹9.99. The last line absorbs the remainder so the invoice foots.
    const breakup = computeInvoiceGst({
      lines: [
        { quantity: D(1), unitPrice: D(100), gstRate: D(18) },
        { quantity: D(1), unitPrice: D(100), gstRate: D(18) },
        { quantity: D(1), unitPrice: D(100), gstRate: D(18) },
      ],
      discount: D(10),
      sellerStateCode: "27",
      placeOfSupply: "27",
    });
    expect(breakup.taxableValue.toString()).toBe("290"); // 300 − 10 exactly
  });

  it("a discount larger than the line value can't make tax negative", async () => {
    const breakup = computeInvoiceGst({
      lines: [{ quantity: D(1), unitPrice: D(100), gstRate: D(18) }],
      discount: D(500),
      sellerStateCode: "27",
      placeOfSupply: "27",
    });
    expect(breakup.taxableValue.toString()).toBe("0");
    expect(breakup.totalTax.toString()).toBe("0");
  });
});

describe("GST — multiple rates on one invoice", () => {
  it("taxes each line at its own rate", async () => {
    // The case a single invoice-level rate cannot express: books at 5% and
    // electronics at 18% on the same bill.
    const breakup = computeInvoiceGst({
      lines: [
        { quantity: D(1), unitPrice: D(1000), gstRate: D(5) },
        { quantity: D(1), unitPrice: D(1000), gstRate: D(18) },
      ],
      sellerStateCode: "27",
      placeOfSupply: "27",
    });
    expect(breakup.lines[0]!.totalTax.toString()).toBe("50");
    expect(breakup.lines[1]!.totalTax.toString()).toBe("180");
    expect(breakup.totalTax.toString()).toBe("230");
  });

  it("groups the summary by rate slab", async () => {
    // A GST invoice must print taxable value and tax under each rate
    // separately — one grand total isn't enough for filing.
    const breakup = computeInvoiceGst({
      lines: [
        { quantity: D(1), unitPrice: D(1000), gstRate: D(5) },
        { quantity: D(1), unitPrice: D(500), gstRate: D(5) },
        { quantity: D(1), unitPrice: D(1000), gstRate: D(18) },
      ],
      sellerStateCode: "27",
      placeOfSupply: "27",
    });
    expect(breakup.byRate).toHaveLength(2);
    const five = breakup.byRate.find((r) => r.gstRate.equals(5))!;
    expect(five.taxableValue.toString()).toBe("1500");
    expect(five.cgstAmount.plus(five.sgstAmount).toString()).toBe("75");
  });

  it("a nil-rated line produces zero tax without breaking the invoice", async () => {
    const breakup = computeInvoiceGst({
      lines: [
        { quantity: D(1), unitPrice: D(1000), gstRate: D(0) },
        { quantity: D(1), unitPrice: D(1000), gstRate: D(18) },
      ],
      sellerStateCode: "27",
      placeOfSupply: "27",
    });
    expect(breakup.lines[0]!.totalTax.toString()).toBe("0");
    expect(breakup.totalTax.toString()).toBe("180");
  });

  it("falls back to the default rate when a product has none", async () => {
    const breakup = computeInvoiceGst({
      lines: [{ quantity: D(1), unitPrice: D(1000), gstRate: null }],
      defaultGstRate: D(12),
      sellerStateCode: "27",
      placeOfSupply: "27",
    });
    expect(breakup.totalTax.toString()).toBe("120");
  });
});

describe("GST — identifiers", () => {
  it("reads the state code from the first two digits of a GSTIN", async () => {
    // A buyer who gives a GSTIN has already stated their state; asking again
    // just invites the two to disagree.
    expect(stateCodeFromGstin("27AAPFU0939F1ZV")).toBe("27");
    expect(stateCodeFromGstin("29AAPFU0939F1ZV")).toBe("29");
  });

  it("returns null for a nonsense state prefix", async () => {
    expect(stateCodeFromGstin("99AAPFU0939F1ZV")).toBeNull();
    expect(stateCodeFromGstin(null)).toBeNull();
    expect(stateCodeFromGstin("")).toBeNull();
  });

  it("validates state codes against the real list", async () => {
    expect(isValidStateCode("27")).toBe(true);
    expect(isValidStateCode("99")).toBe(false);
    expect(isValidStateCode(null)).toBe(false);
  });

  it("checks GSTIN shape without claiming the number is registered", async () => {
    // Shape only. A structurally valid GSTIN can still belong to nobody, so
    // treating this as proof of registration would be a mistake.
    expect(isValidGstinShape("27AAPFU0939F1ZV")).toBe(true);
    expect(isValidGstinShape("27AAPFU0939F1Z")).toBe(false); // too short
    expect(isValidGstinShape("AAPFU093927F1ZV")).toBe(false); // no state digits
  });
});
