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
  totalAmount: Decimal;
  paidAmount: Decimal;
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
  payments: { amount: Decimal }[]
): PaymentSummary {
  const paidAmount = payments
    .reduce((s, p) => s.plus(p.amount), new D(0))
    .toDecimalPlaces(2);
  const balanceAmount = totalAmount.minus(paidAmount).toDecimalPlaces(2);

  let paymentStatus: PaymentStatus;
  if (paidAmount.isZero()) {
    paymentStatus = "UNPAID";
  } else if (paidAmount.lessThan(totalAmount)) {
    paymentStatus = "PARTIAL";
  } else if (paidAmount.equals(totalAmount)) {
    paymentStatus = "PAID";
  } else {
    paymentStatus = "OVERPAID";
  }

  return { totalAmount, paidAmount, balanceAmount, paymentStatus };
}
