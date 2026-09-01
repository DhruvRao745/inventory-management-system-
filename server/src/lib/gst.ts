/**
 * GST rules — one place, deliberately isolated (P2-3, PRD §16).
 *
 * WHAT GST ACTUALLY IS, IN ONE PARAGRAPH
 *
 * Indian GST is one tax collected by two governments. On a sale within your
 * own state the tax splits in half: CGST to the centre, SGST to the state. On
 * a sale to another state the whole amount goes as IGST instead, and the
 * centre settles up with the destination state later. The TOTAL is identical
 * either way — 18% is 18% — but the SPLIT is different, and the invoice is the
 * legal document that records which. Getting the split wrong doesn't change
 * what the customer pays; it means money was reported to the wrong government.
 *
 *     Seller Maharashtra → buyer Maharashtra, 18% on ₹1,000
 *         CGST ₹90 + SGST ₹90
 *     Seller Maharashtra → buyer Karnataka, 18% on ₹1,000
 *         IGST ₹180
 *
 * So the question that decides everything is not "what am I selling?" but
 * "where is the customer?".
 *
 * WHY THIS FILE HAS NO DATABASE ACCESS
 *
 * PRD §16: "Keep GST rules modular so future rule changes do not require
 * rewriting invoice logic." Rates and rules change by government notification,
 * sometimes at a few days' notice. Everything here is pure — numbers and
 * strings in, numbers out — so the rules can be changed, unit-tested and
 * reasoned about without touching how an invoice is built or stored.
 *
 * WHAT THIS FILE IS NOT
 *
 * This is not GST compliance. PRD §16 is explicit: "Do not claim full GST
 * compliance unless all required business rules are implemented and verified."
 * Not implemented here: reverse charge, composition scheme, e-way bills,
 * e-invoicing/IRN, TCS, exports and SEZ (zero-rated), input tax credit
 * matching, and GSTR return filing. What this DOES give you is a correct
 * per-line tax computation with an honest audit trail — the foundation those
 * things would be built on, not a substitute for them.
 */
import { Prisma } from "@prisma/client";

const D = Prisma.Decimal;
type Decimal = Prisma.Decimal;

export type SupplyType = "INTRA_STATE" | "INTER_STATE";

/**
 * The 36 GST state codes, as used in the first two digits of a GSTIN.
 * Kept as data rather than a free-text field so a typo can be caught.
 */
export const GST_STATE_CODES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
};

export function isValidStateCode(code: string | null | undefined): boolean {
  return !!code && code in GST_STATE_CODES;
}

export function stateName(code: string | null | undefined): string | null {
  return code && code in GST_STATE_CODES ? GST_STATE_CODES[code]! : null;
}

/**
 * The first two digits of a GSTIN are the state code.
 *
 * Useful because a buyer who gives you a GSTIN has already told you their
 * state, and asking again invites a mismatch between the two.
 */
export function stateCodeFromGstin(
  gstin: string | null | undefined
): string | null {
  if (!gstin || gstin.length < 2) return null;
  const code = gstin.slice(0, 2);
  return code in GST_STATE_CODES ? code : null;
}

/**
 * A GSTIN is 15 characters: 2 state + 10 PAN + 1 entity + 1 'Z' + 1 checksum.
 *
 * Shape only — this does NOT verify the number is real or registered. A
 * structurally valid GSTIN can still belong to nobody, so treating this as
 * proof of registration would be a mistake.
 */
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

export function isValidGstinShape(gstin: string): boolean {
  return GSTIN_PATTERN.test(gstin.toUpperCase());
}

/**
 * Intra-state or inter-state?
 *
 * Note what happens when the place of supply is unknown: we treat it as
 * INTRA_STATE, the same state as the seller. That is the right default for the
 * overwhelmingly common case — a walk-in customer at a shop counter, who has
 * given no address and is standing in the seller's own state. Defaulting to
 * INTER_STATE would put every counter sale in the wrong bucket.
 */
export function determineSupplyType(
  sellerStateCode: string | null | undefined,
  placeOfSupply: string | null | undefined
): SupplyType {
  if (!sellerStateCode || !placeOfSupply) return "INTRA_STATE";
  return sellerStateCode === placeOfSupply ? "INTRA_STATE" : "INTER_STATE";
}

export type LineTaxInput = {
  /** Line value AFTER any discount — tax is charged on what is actually paid. */
  taxableValue: Decimal;
  /** Total GST percentage for this line: 5, 12, 18, 28... */
  gstRate: Decimal;
  supplyType: SupplyType;
};

export type LineTax = {
  taxableValue: Decimal;
  gstRate: Decimal;
  cgstAmount: Decimal;
  sgstAmount: Decimal;
  igstAmount: Decimal;
  totalTax: Decimal;
};

const ZERO = new D(0);

/**
 * Split one line's tax into its components.
 *
 * ROUNDING, WHICH IS THE FIDDLY PART
 *
 * Tax is rounded to paise per LINE, not on the invoice total. Two lines at
 * ₹0.005 tax each must not become ₹0.01 by being added together first — the
 * invoice has to foot exactly, line by line, or an accountant checking it will
 * find a discrepancy they cannot explain.
 *
 * For intra-state, CGST and SGST are each HALF the total. Computing the total
 * first and halving it can leave a stray paisa (₹0.03 → ₹0.015 each), so we
 * round the half and derive the other half by subtraction. That guarantees
 * CGST + SGST == total exactly, with the odd paisa landing on SGST rather than
 * disappearing.
 */
export function computeLineTax(input: LineTaxInput): LineTax {
  const taxableValue = input.taxableValue.toDecimalPlaces(2);
  const gstRate = input.gstRate;

  const totalTax = taxableValue.times(gstRate).dividedBy(100).toDecimalPlaces(2);

  if (input.supplyType === "INTER_STATE") {
    return {
      taxableValue,
      gstRate,
      cgstAmount: ZERO,
      sgstAmount: ZERO,
      igstAmount: totalTax,
      totalTax,
    };
  }

  // Half to the centre, the remainder to the state — so the two always sum
  // back to exactly totalTax, whatever the rounding.
  const cgstAmount = totalTax.dividedBy(2).toDecimalPlaces(2);
  const sgstAmount = totalTax.minus(cgstAmount);

  return {
    taxableValue,
    gstRate,
    cgstAmount,
    sgstAmount,
    igstAmount: ZERO,
    totalTax,
  };
}

export type InvoiceLineForTax = {
  quantity: Decimal;
  unitPrice: Decimal;
  gstRate: Decimal | null;
  hsnCode?: string | null;
};

export type GstBreakup = {
  supplyType: SupplyType;
  subtotal: Decimal; // sum of line values, before discount and tax
  discount: Decimal;
  taxableValue: Decimal; // what tax was actually charged on
  cgstAmount: Decimal;
  sgstAmount: Decimal;
  igstAmount: Decimal;
  totalTax: Decimal;
  grandTotal: Decimal;
  /** Per-rate summary — what a GST invoice must print, and what returns need. */
  byRate: {
    gstRate: Decimal;
    taxableValue: Decimal;
    cgstAmount: Decimal;
    sgstAmount: Decimal;
    igstAmount: Decimal;
  }[];
  /** Tax for each line, in the order the lines were given. */
  lines: LineTax[];
};

/**
 * Compute GST for a whole invoice.
 *
 * DISCOUNT HANDLING, WHICH IS EASY TO GET WRONG
 *
 * A discount is stored as one flat amount off the invoice, but tax is charged
 * per line. So the discount has to be SPREAD across the lines in proportion to
 * their value before any tax is worked out — you cannot tax the full line
 * values and then subtract a discount at the end, because that charges the
 * customer tax on money they never paid.
 *
 * The last line absorbs any rounding remainder from that apportionment, so the
 * apportioned discounts sum to exactly the discount given. Otherwise a ₹10
 * discount across three lines becomes ₹9.99 and the invoice fails to foot.
 */
export function computeInvoiceGst(params: {
  lines: InvoiceLineForTax[];
  discount?: Decimal | null;
  sellerStateCode?: string | null;
  placeOfSupply?: string | null;
  /** Rate used for any line whose product has none set. */
  defaultGstRate?: Decimal | null;
}): GstBreakup {
  const supplyType = determineSupplyType(
    params.sellerStateCode,
    params.placeOfSupply
  );

  const lineValues = params.lines.map((l) =>
    l.unitPrice.times(l.quantity).toDecimalPlaces(2)
  );
  const subtotal = lineValues
    .reduce((s, v) => s.plus(v), ZERO)
    .toDecimalPlaces(2);

  const discount = (params.discount ?? ZERO).toDecimalPlaces(2);

  // Spread the discount proportionally. Guard against a zero subtotal so a
  // discount on an empty invoice can't divide by zero.
  const apportioned: Decimal[] = [];
  let allocated = ZERO;
  lineValues.forEach((value, i) => {
    const isLast = i === lineValues.length - 1;
    if (isLast) {
      // The remainder lands here, so the parts sum to exactly `discount`.
      apportioned.push(discount.minus(allocated));
      return;
    }
    const share = subtotal.isZero()
      ? ZERO
      : discount.times(value).dividedBy(subtotal).toDecimalPlaces(2);
    apportioned.push(share);
    allocated = allocated.plus(share);
  });

  const lines: LineTax[] = params.lines.map((line, i) => {
    const net = Prisma.Decimal.max(
      ZERO,
      lineValues[i]!.minus(apportioned[i] ?? ZERO)
    );
    const rate = line.gstRate ?? params.defaultGstRate ?? ZERO;
    return computeLineTax({
      taxableValue: net,
      gstRate: rate,
      supplyType,
    });
  });

  const sum = (pick: (l: LineTax) => Decimal) =>
    lines.reduce((s, l) => s.plus(pick(l)), ZERO).toDecimalPlaces(2);

  const taxableValue = sum((l) => l.taxableValue);
  const cgstAmount = sum((l) => l.cgstAmount);
  const sgstAmount = sum((l) => l.sgstAmount);
  const igstAmount = sum((l) => l.igstAmount);
  const totalTax = sum((l) => l.totalTax);

  // Group by rate — a GST invoice must show the taxable value and tax under
  // each rate slab separately, not just one grand total.
  const rateMap = new Map<string, GstBreakup["byRate"][number]>();
  for (const l of lines) {
    const key = l.gstRate.toString();
    const row = rateMap.get(key) ?? {
      gstRate: l.gstRate,
      taxableValue: ZERO,
      cgstAmount: ZERO,
      sgstAmount: ZERO,
      igstAmount: ZERO,
    };
    row.taxableValue = row.taxableValue.plus(l.taxableValue);
    row.cgstAmount = row.cgstAmount.plus(l.cgstAmount);
    row.sgstAmount = row.sgstAmount.plus(l.sgstAmount);
    row.igstAmount = row.igstAmount.plus(l.igstAmount);
    rateMap.set(key, row);
  }

  return {
    supplyType,
    subtotal,
    discount,
    taxableValue,
    cgstAmount,
    sgstAmount,
    igstAmount,
    totalTax,
    grandTotal: taxableValue.plus(totalTax).toDecimalPlaces(2),
    byRate: [...rateMap.values()].sort((a, b) =>
      a.gstRate.comparedTo(b.gstRate)
    ),
    lines,
  };
}
