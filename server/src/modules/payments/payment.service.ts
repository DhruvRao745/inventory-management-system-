/**
 * Payments (P1-5).
 *
 * WHAT WAS WRONG BEFORE
 *
 * "Paid" was a status someone flipped. No record of how much arrived, when, or
 * by what means. A half-paid invoice could not be represented at all, and
 * "who still owes us money?" had no answer the system could give — which for a
 * business is not a missing feature so much as a missing organ.
 *
 * THE RULE (PRD §8)
 *
 * "Do not infer payment state only from a status field."
 *
 * So payment state is DERIVED from payment rows. `Invoice.status` still reads
 * PAID, but as a consequence of the arithmetic, never as its cause — it is
 * kept in step here so existing filters and screens keep working.
 *
 * CONCURRENCY
 *
 * Recording a payment is: read the payments so far → sum → check it fits →
 * insert. That is the same read-then-write shape as the oversell bug from P0.
 * Two people recording the last ₹500 of a ₹1,000 invoice at the same moment
 * would both see ₹500 outstanding and both be allowed — ₹1,500 collected
 * against a ₹1,000 invoice, with nothing in the system objecting.
 *
 * So every mutation here runs inside `lockDocument(tx, "invoice", invoiceId)`.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import { lockDocument, LOCKED_TX_OPTIONS } from "../../lib/locks.js";
import { recordAudit } from "../../lib/audit.js";
import {
  invoiceTotalDecimal,
  summarisePayments,
  type PaymentSummary,
} from "../../lib/money.js";
import type { CreatePaymentInput, ListPaymentsQuery } from "./payment.schemas.js";

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const paymentInclude = {
  createdBy: { select: { id: true, name: true } },
  invoice: { select: { id: true, number: true, customerName: true } },
} as const;

/**
 * What an invoice is worth.
 *
 * Routed by taxMode since P2-3 — a GST invoice's total is the sum of the tax
 * STAMPED on its lines, not a recomputation. This matters here more than
 * anywhere: a payment is validated against the balance, so if the total were
 * recomputed under changed rates, an invoice that was paid in full could
 * quietly develop an outstanding balance months later.
 */
function invoiceTotal(inv: {
  taxMode?: string | null;
  lines: {
    quantity: Prisma.Decimal;
    unitPrice: Prisma.Decimal;
    taxableValue?: Prisma.Decimal | null;
    cgstAmount?: Prisma.Decimal | null;
    sgstAmount?: Prisma.Decimal | null;
    igstAmount?: Prisma.Decimal | null;
  }[];
  taxRate: Prisma.Decimal | null;
  discount: Prisma.Decimal | null;
}): Prisma.Decimal {
  return invoiceTotalDecimal(inv);
}

/**
 * The four figures PRD §8 requires an invoice to expose.
 * Exported so inv.service can attach them without duplicating the maths.
 */
export async function paymentSummaryFor(
  tx: Tx,
  companyId: string,
  invoiceId: string
): Promise<PaymentSummary> {
  const inv = await tx.invoice.findFirst({
    where: { id: invoiceId, companyId },
    select: {
      taxMode: true, // decides which total calculation applies (P2-3)
      taxRate: true,
      discount: true,
      lines: {
          select: {
            quantity: true,
            unitPrice: true,
            // Stamped GST (P2-3) — needed so invoiceTotal can SUM the tax
            // that was saved rather than recompute it.
            taxableValue: true,
            cgstAmount: true,
            sgstAmount: true,
            igstAmount: true,
          },
        },
      payments: { select: { amount: true } },
    },
  });
  if (!inv) throw new AppError(404, "Invoice not found");
  return summarisePayments(invoiceTotal(inv), inv.payments);
}

/**
 * Keep `Invoice.status` in step with the money.
 *
 * Deliberately one-directional: payments decide the status, never the reverse.
 * CANCELLED and DRAFT are left alone — a cancelled invoice that happens to
 * have a payment against it is a refund situation, not a paid sale, and
 * silently relabelling it PAID would bury that.
 */
async function syncInvoiceStatus(
  tx: Tx,
  invoiceId: string,
  summary: PaymentSummary
): Promise<void> {
  const inv = await tx.invoice.findUnique({
    where: { id: invoiceId },
    select: { status: true },
  });
  if (!inv) return;
  if (inv.status === "CANCELLED" || inv.status === "DRAFT") return;

  const fullyPaid =
    summary.paidAmount.greaterThanOrEqualTo(summary.totalAmount) &&
    summary.totalAmount.greaterThan(0);
  const target = fullyPaid ? "PAID" : "ISSUED";

  if (inv.status !== target) {
    await tx.invoice.update({ where: { id: invoiceId }, data: { status: target } });
  }
}

export async function recordPayment(
  companyId: string,
  userId: string,
  input: CreatePaymentInput
) {
  return prisma.$transaction(async (tx) => {
    // Serialize against this invoice BEFORE reading its payments, or two
    // simultaneous payments both see the same balance and both fit.
    await lockDocument(tx, "invoice", input.invoiceId);

    const inv = await tx.invoice.findFirst({
      where: { id: input.invoiceId, companyId },
      select: {
        id: true,
        number: true,
        status: true,
        taxMode: true, // decides which total calculation applies (P2-3)
        taxRate: true,
        discount: true,
        lines: {
          select: {
            quantity: true,
            unitPrice: true,
            // Stamped GST (P2-3) — needed so invoiceTotal can SUM the tax
            // that was saved rather than recompute it.
            taxableValue: true,
            cgstAmount: true,
            sgstAmount: true,
            igstAmount: true,
          },
        },
        payments: { select: { amount: true } },
      },
    });
    if (!inv) throw new AppError(404, "Invoice not found");

    // A draft isn't a bill yet — money against it has nothing to settle.
    if (inv.status === "DRAFT") {
      throw new AppError(409, "Issue the invoice before recording payment");
    }
    if (inv.status === "CANCELLED") {
      throw new AppError(409, "This invoice was cancelled");
    }

    const total = invoiceTotal(inv);
    const before = summarisePayments(total, inv.payments);
    const amount = new Prisma.Decimal(input.amount).toDecimalPlaces(2);

    if (before.balanceAmount.lessThanOrEqualTo(0)) {
      throw new AppError(409, "This invoice is already fully paid");
    }
    if (amount.greaterThan(before.balanceAmount)) {
      throw new AppError(
        400,
        `That's more than the ${before.balanceAmount.toString()} outstanding on this invoice`
      );
    }

    const payment = await tx.payment.create({
      data: {
        companyId,
        invoiceId: inv.id,
        amount,
        method: input.method,
        paymentDate: input.paymentDate ? new Date(input.paymentDate) : undefined,
        reference: input.reference,
        notes: input.notes,
        createdById: userId,
      },
      include: paymentInclude,
    });

    const after = summarisePayments(total, [...inv.payments, { amount }]);
    await syncInvoiceStatus(tx, inv.id, after);

    await recordAudit(tx, {
      companyId,
      userId,
      action: "payment.record",
      entity: "payment",
      entityId: payment.id,
      summary: `${amount.toString()} received against INV-${String(inv.number).padStart(4, "0")} by ${input.method}`,
      after: {
        invoiceId: inv.id,
        amount: amount.toString(),
        method: input.method,
        balanceAfter: after.balanceAmount.toString(),
      },
    });

    return { payment, summary: after };
  }, LOCKED_TX_OPTIONS);
}

export async function listPayments(companyId: string, q: ListPaymentsQuery) {
  const where = {
    companyId,
    ...(q.invoiceId ? { invoiceId: q.invoiceId } : {}),
    ...(q.from || q.to
      ? {
          paymentDate: {
            ...(q.from ? { gte: new Date(q.from) } : {}),
            ...(q.to ? { lte: new Date(q.to) } : {}),
          },
        }
      : {}),
  };

  const [items, total, sum] = await Promise.all([
    prisma.payment.findMany({
      where,
      orderBy: { paymentDate: "desc" },
      take: q.take,
      skip: q.skip,
      include: paymentInclude,
    }),
    prisma.payment.count({ where }),
    prisma.payment.aggregate({ where, _sum: { amount: true } }),
  ]);

  return {
    items,
    total,
    take: q.take,
    skip: q.skip,
    totalAmount: sum._sum.amount ?? new Prisma.Decimal(0),
  };
}

export async function getPayment(companyId: string, id: string) {
  const payment = await prisma.payment.findFirst({
    where: { id, companyId },
    include: paymentInclude,
  });
  if (!payment) throw new AppError(404, "Payment not found");
  return payment;
}

/**
 * Delete a payment — the correction path for a mistyped amount.
 *
 * Payments are deletable where stock movements are not, and the difference is
 * deliberate: a stock movement records a physical event that genuinely
 * happened, so it is corrected by a compensating entry. A payment that was
 * never received didn't happen at all, and leaving a phantom ₹5,000 on the
 * books to be "corrected" by a phantom −₹5,000 makes the customer's statement
 * harder to read, not easier.
 */
export async function deletePayment(companyId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.payment.findFirst({
      where: { id, companyId },
      select: { id: true, invoiceId: true },
    });
    if (!existing) throw new AppError(404, "Payment not found");

    await lockDocument(tx, "invoice", existing.invoiceId);
    await tx.payment.delete({ where: { id: existing.id } });

    // Removing money can un-pay an invoice, so the status has to follow.
    const summary = await paymentSummaryFor(tx, companyId, existing.invoiceId);
    await syncInvoiceStatus(tx, existing.invoiceId, summary);

    return { summary };
  }, LOCKED_TX_OPTIONS);
}

/**
 * Outstanding customer balances — "who owes us money?", which the system
 * previously could not answer at all.
 */
export async function outstandingBalances(companyId: string) {
  const invoices = await prisma.invoice.findMany({
    where: { companyId, status: { in: ["ISSUED", "PAID"] } },
    select: {
      id: true,
      number: true,
      customerName: true,
      issuedAt: true,
      taxMode: true, // decides which total calculation applies (P2-3)
      taxRate: true,
      discount: true,
      lines: {
          select: {
            quantity: true,
            unitPrice: true,
            // Stamped GST (P2-3) — needed so invoiceTotal can SUM the tax
            // that was saved rather than recompute it.
            taxableValue: true,
            cgstAmount: true,
            sgstAmount: true,
            igstAmount: true,
          },
        },
      payments: { select: { amount: true } },
    },
    orderBy: { number: "desc" },
  });

  const rows = invoices
    .map((inv) => {
      const s = summarisePayments(invoiceTotal(inv), inv.payments);
      return {
        invoiceId: inv.id,
        number: inv.number,
        customerName: inv.customerName,
        issuedAt: inv.issuedAt,
        totalAmount: Number(s.totalAmount),
        paidAmount: Number(s.paidAmount),
        balanceAmount: Number(s.balanceAmount),
        paymentStatus: s.paymentStatus,
      };
    })
    .filter((r) => r.balanceAmount > 0);

  return {
    rows,
    totalOutstanding: Number(
      rows.reduce((s, r) => s + r.balanceAmount, 0).toFixed(2)
    ),
  };
}
