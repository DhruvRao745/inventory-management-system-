/**
 * Invoice money maths — one place, shared (P1-5).
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * `payment.service` needs the invoice total to validate a payment against it.
 * `inv.service` needs the payment summary to report a balance. Each importing
 * the other is a circular import — the kind that "works" until module load
 * order shifts and something is suddenly `undefined` at runtime, with a stack
 * trace pointing nowhere useful.
 *
 * Both of these functions are pure: numbers in, numbers out, no database. So
 * they live here, and both services import downward from a shared leaf.
 */
import { Prisma } from "@prisma/client";

const D = Prisma.Decimal;
type Decimal = Prisma.Decimal;

/**
 * What the customer actually owes: (subtotal − discount) + tax on that amount.
 *
 * Tax applies AFTER the discount, not before — discounting ₹100 by ₹10 and
 * then taxing means tax on ₹90. Taxing first would overcharge the customer,
 * which is both wrong and the sort of wrong that gets noticed.
 */
export function grandTotal(
  subtotal: number,
  taxRate: unknown,
  discount: unknown
): number {
  const disc = Number(discount ?? 0);
  const taxable = Math.max(0, subtotal - disc);
  const tax = taxable * (Number(taxRate ?? 0) / 100);
  return Math.round((taxable + tax) * 100) / 100;
}

/** Same calculation in Decimal, for anywhere that must not touch a float. */
export function grandTotalDecimal(
  subtotal: Decimal,
  taxRate: Decimal | null,
  discount: Decimal | null
): Decimal {
  const taxable = Prisma.Decimal.max(
    new D(0),
    subtotal.minus(discount ?? new D(0))
  );
  const tax = taxable.times(taxRate ?? new D(0)).dividedBy(100);
  return taxable.plus(tax).toDecimalPlaces(2);
}

/**
 * The total of an invoice, whichever tax regime it was raised under (P2-3).
 *
 * THE RULE THIS ENFORCES: an issued invoice's total is READ, never recomputed.
 *
 * A GST invoice has its tax stamped on its lines at issue time. This function
 * ADDS UP those stored amounts; it does not re-derive them from today's rates.
 * That distinction is the whole point — if a rate changes next April, every
 * invoice ever issued must keep the figures that were on the copy the customer
 * received. Recomputing would silently rewrite financial history, and the two
 * copies of the same document would stop agreeing.
 *
 * Legacy FLAT invoices have no per-line tax, so they fall back to the old
 * whole-invoice calculation on their own stored `taxRate`. `taxMode` decides
 * which path applies, so "no GST columns" and "GST of zero" are never confused
 * — a nil-rated GST invoice is a real thing and must not look like a legacy one.
 */
export function invoiceTotalDecimal(inv: {
  taxMode?: string | null;
  taxRate: Decimal | null;
  discount: Decimal | null;
  lines: {
    quantity: Decimal;
    unitPrice: Decimal;
    cgstAmount?: Decimal | null;
    sgstAmount?: Decimal | null;
    igstAmount?: Decimal | null;
    taxableValue?: Decimal | null;
  }[];
}): Decimal {
  if (inv.taxMode !== "GST") {
    return grandTotalDecimal(lineSubtotal(inv.lines), inv.taxRate, inv.discount);
  }

  // Sum what was stamped. `taxableValue` already has the discount applied per
  // line, so the discount must NOT be subtracted again here.
  const zero = new D(0);
  return inv.lines
    .reduce(
      (sum, l) =>
        sum
          .plus(l.taxableValue ?? zero)
          .plus(l.cgstAmount ?? zero)
          .plus(l.sgstAmount ?? zero)
          .plus(l.igstAmount ?? zero),
      zero
    )
    .toDecimalPlaces(2);
}

/** Sum of an invoice's lines, before discount and tax. */
export function lineSubtotal(
  lines: { quantity: Decimal; unitPrice: Decimal }[]
): Decimal {
  return lines
    .reduce((s, l) => s.plus(l.unitPrice.times(l.quantity)), new D(0))
    .toDecimalPlaces(2);
}

export type PaymentStatus = "UNPAID" | "PARTIAL" | "PAID" | "OVERPAID";

export type PaymentSummary = {
  /** The invoice as issued. Historical fact — never reduced by a return. */
  totalAmount: Decimal;
  /** Money that came IN. Also historical — a refund is not an un-payment. */
  paidAmount: Decimal;

  // --- returns (BUG-3) --------------------------------------------------
  /** Value of goods returned, at this invoice's own basis. */
  returnedAmount: Decimal;
  /** Money handed back to the customer. */
  refundedAmount: Decimal;
  /** totalAmount − returnedAmount: what the customer actually keeps. */
  netTotalAmount: Decimal;
  /** paidAmount − refundedAmount: what we are actually holding. */
  netPaidAmount: Decimal;

  /**
   * netTotal − netPaid. Positive = they owe us; NEGATIVE = we owe them, which
   * is what an accepted return that hasn't been refunded yet looks like.
   */
  balanceAmount: Decimal;
  paymentStatus: PaymentStatus;
};

/**
 * Derive payment state from the actual payments — never from a status flag.
 *
 * PRD §8 is explicit about this. A flag can be set by anyone, drift from
 * reality, and leaves "how much is still owed?" unanswerable. These four
 * figures are computed from rows that record real money, so they cannot
 * disagree with the ledger of what arrived.
 *
 * OVERPAID is reported rather than prevented at this level: the service
 * refuses overpayment on the way in, but if historical data already contains
 * one, a report that quietly said "PAID" would be hiding a refund the business
 * owes someone.
 */
export function summarisePayments(
  totalAmount: Decimal,
  payments: { amount: Decimal }[],
  /**
   * Returns settled against this invoice (BUG-3). Omitted where an invoice
   * cannot have returns yet — the defaults make this a no-op, so every
   * existing caller behaves exactly as before.
   */
  returns: { returnedAmount?: Decimal; refundedAmount?: Decimal } = {}
): PaymentSummary {
  const paidAmount = payments
    .reduce((s, p) => s.plus(p.amount), new D(0))
    .toDecimalPlaces(2);

  const returnedAmount = (returns.returnedAmount ?? new D(0)).toDecimalPlaces(2);
  const refundedAmount = (returns.refundedAmount ?? new D(0)).toDecimalPlaces(2);

  // The invoice and the payments stay as they happened; what the customer
  // OWES is derived. Editing either to "apply" a return would destroy the
  // record of what was billed and what was collected.
  const netTotalAmount = totalAmount.minus(returnedAmount).toDecimalPlaces(2);
  const netPaidAmount = paidAmount.minus(refundedAmount).toDecimalPlaces(2);
  const balanceAmount = netTotalAmount.minus(netPaidAmount).toDecimalPlaces(2);

  // Status is judged on the NET figures, because that is the question being
  // asked: is this settled? A fully returned and refunded invoice is settled,
  // even though both gross numbers are large.
  let paymentStatus: PaymentStatus;
  if (netTotalAmount.lessThanOrEqualTo(0) && balanceAmount.lessThanOrEqualTo(0)) {
    // Nothing left to collect — the sale was fully unwound.
    paymentStatus = "PAID";
  } else if (netPaidAmount.lessThanOrEqualTo(0)) {
    paymentStatus = "UNPAID";
  } else if (netPaidAmount.lessThan(netTotalAmount)) {
    paymentStatus = "PARTIAL";
  } else if (netPaidAmount.equals(netTotalAmount)) {
    paymentStatus = "PAID";
  } else {
    // We are holding more of their money than the net sale justifies.
    paymentStatus = "OVERPAID";
  }

  return {
    totalAmount,
    paidAmount,
    returnedAmount,
    refundedAmount,
    netTotalAmount,
    netPaidAmount,
    balanceAmount,
    paymentStatus,
  };
}
