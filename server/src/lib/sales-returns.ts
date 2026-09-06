/**
 * Sales-return reconciliation — one definition of "what came back", shared by
 * the invoice, the payment balance and every report.
 *
 * WHAT WAS WRONG (BUG-3, found in testing)
 *
 * A return moved stock and recorded a refund, and stopped there. The invoice
 * it was raised against never mentioned it, the balance ignored the refund,
 * and revenue, COGS and profit were all still gross. So the same five pieces
 * were simultaneously back on the shelf and still sold.
 *
 * The returns data was never the problem — it was complete. Nothing READ it.
 *
 * THE SOURCE OF TRUTH FOR EACH VALUE
 *
 *   what was sold          Invoice + InvoiceLine     (immutable, never edited)
 *   what came back         SalesReturnLine           (quantity + condition)
 *   what it was worth      InvoiceLine.unitPrice     (the price it sold at)
 *   what we paid back      SalesReturn.refundAmount  (a decision, not a sum)
 *   where the stock went   StockMovement RETURN_IN   (status = condition)
 *   what it cost us        StockMovement.costAtTime  (set by costReturnIn)
 *
 * The invoice is NEVER rewritten. A sold invoice is a historical fact and a
 * legal document; you don't go back and edit what the customer was billed.
 * Net figures are DERIVED — invoice minus returns — every time they're asked
 * for. That is why a return can never leave the invoice and the report
 * disagreeing: there is nothing stored to fall out of step.
 *
 * WHICH RETURNS COUNT
 *
 * RECEIVED and REFUNDED — the two states where the goods are physically back.
 * A REQUESTED or APPROVED return is a conversation, not a reversal: no stock
 * has moved, so reversing revenue would report a sale as undone while the
 * goods are still at the customer's house. This matches the ledger exactly,
 * which is the point — the money view and the stock view move together.
 *
 * (The double-return guard in return.service.ts deliberately counts every
 * non-cancelled return instead, including REQUESTED ones. Different question:
 * "may this be sent back?" must be pessimistic, "what has come back?" must be
 * factual.)
 *
 * VALUE AT THE INVOICE'S OWN BASIS
 *
 * A line's raw value is quantity × unitPrice, but the customer paid the
 * invoice TOTAL — after discount, plus tax. So the returned value is scaled by
 * the line's share of the subtotal, exactly the way the sales report already
 * spreads discount and tax across lines. Without that scaling, a return
 * against a discounted invoice would credit back more than was ever charged.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { invoiceTotalDecimal } from "./money.js";

/** Anything that can run a query: the client, or a transaction client. */
type Client = typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

type Decimal = Prisma.Decimal;
const D = (n: number | string = 0) => new Prisma.Decimal(n);

/** The states in which goods are actually back in our hands. */
export const SETTLED_RETURN_STATUSES = ["RECEIVED", "REFUNDED"] as const;

/** One settled return line, flattened for reconciliation. */
export type SettledReturnLine = {
  invoiceId: string;
  invoiceLineId: string;
  productId: string;
  quantity: Decimal;
  condition: "SELLABLE" | "DAMAGED" | "QUARANTINE";
};

export type InvoiceReturnSummary = {
  /** invoiceLineId → quantity returned (all conditions). */
  quantityByLine: Map<string, Decimal>;
  /** productId → quantity returned. */
  quantityByProduct: Map<string, Decimal>;
  /** Raw quantity × unitPrice, before the invoice's discount and tax. */
  returnedSubtotal: Decimal;
  /** Returned value at the invoice's own basis — comparable to totalAmount. */
  returnedAmount: Decimal;
  /** Money actually given back (REFUNDED returns only). */
  refundedAmount: Decimal;
  /** Units back, split by the condition they came back in. */
  quantityByCondition: Record<"SELLABLE" | "DAMAGED" | "QUARANTINE", Decimal>;
  /** True when nothing is left un-returned on any line. */
  fullyReturned: boolean;
};

export function emptyReturnSummary(): InvoiceReturnSummary {
  return {
    quantityByLine: new Map(),
    quantityByProduct: new Map(),
    returnedSubtotal: D(),
    returnedAmount: D(),
    refundedAmount: D(),
    quantityByCondition: { SELLABLE: D(), DAMAGED: D(), QUARANTINE: D() },
    fullyReturned: false,
  };
}

/** The invoice shape this module needs — a subset of what callers already load. */
type InvoiceLike = {
  id: string;
  taxMode?: string | null;
  taxRate: Decimal | null;
  discount: Decimal | null;
  lines: {
    id: string;
    productId: string;
    quantity: Decimal;
    unitPrice: Decimal;
    taxableValue?: Decimal | null;
    cgstAmount?: Decimal | null;
    sgstAmount?: Decimal | null;
    igstAmount?: Decimal | null;
  }[];
};

/**
 * Fold one invoice's settled return lines into the figures every caller needs.
 * Pure — no database access — so the arithmetic can be tested on its own.
 */
export function summariseInvoiceReturns(
  invoice: InvoiceLike,
  lines: SettledReturnLine[],
  refunds: { refundAmount: Decimal | null }[]
): InvoiceReturnSummary {
  const summary = emptyReturnSummary();

  const lineById = new Map(invoice.lines.map((l) => [l.id, l]));

  for (const r of lines) {
    const invLine = lineById.get(r.invoiceLineId);
    if (!invLine) continue; // belongs to another invoice; not ours to count

    summary.quantityByLine.set(
      r.invoiceLineId,
      (summary.quantityByLine.get(r.invoiceLineId) ?? D()).plus(r.quantity)
    );
    summary.quantityByProduct.set(
      r.productId,
      (summary.quantityByProduct.get(r.productId) ?? D()).plus(r.quantity)
    );
    summary.quantityByCondition[r.condition] =
      summary.quantityByCondition[r.condition].plus(r.quantity);

    // Value at the price it was SOLD at, not today's price.
    summary.returnedSubtotal = summary.returnedSubtotal.plus(
      r.quantity.times(invLine.unitPrice)
    );
  }

  summary.refundedAmount = refunds
    .reduce((s, r) => s.plus(r.refundAmount ?? D()), D())
    .toDecimalPlaces(2);

  // Scale to the invoice's own basis so netTotal and the reports reconcile.
  const subtotal = invoice.lines.reduce(
    (s, l) => s.plus(l.unitPrice.times(l.quantity)),
    D()
  );
  const total = invoiceTotalDecimal(invoice as Parameters<typeof invoiceTotalDecimal>[0]);
  summary.returnedAmount = subtotal.greaterThan(0)
    ? summary.returnedSubtotal.times(total).dividedBy(subtotal).toDecimalPlaces(2)
    : D();

  summary.fullyReturned =
    invoice.lines.length > 0 &&
    invoice.lines.every((l) =>
      (summary.quantityByLine.get(l.id) ?? D()).greaterThanOrEqualTo(l.quantity)
    );

  return summary;
}

/**
 * What is left of a line after returns — the "net sold" quantity.
 * Never negative: you cannot return more than was sold (the service enforces
 * that), but clamping keeps a bad row from producing a negative sale.
 */
export function netQuantity(sold: Decimal, returned: Decimal | undefined): Decimal {
  const net = sold.minus(returned ?? D());
  return net.lessThan(0) ? D() : net;
}

/**
 * Load every settled return line for a set of invoices, plus the refunds
 * recorded against them. One query per shape, never one per invoice — this is
 * called from report loops.
 */
export async function loadSettledReturns(
  client: Client,
  companyId: string,
  invoiceIds: string[]
): Promise<
  Map<
    string,
    { lines: SettledReturnLine[]; refunds: { refundAmount: Decimal | null }[] }
  >
> {
  const byInvoice = new Map<
    string,
    { lines: SettledReturnLine[]; refunds: { refundAmount: Decimal | null }[] }
  >();
  if (invoiceIds.length === 0) return byInvoice;

  const returns = await client.salesReturn.findMany({
    where: {
      companyId,
      invoiceId: { in: invoiceIds },
      status: { in: [...SETTLED_RETURN_STATUSES] },
    },
    select: {
      invoiceId: true,
      status: true,
      refundAmount: true,
      lines: {
        select: {
          invoiceLineId: true,
          productId: true,
          quantity: true,
          condition: true,
        },
      },
    },
  });

  for (const ret of returns) {
    const bucket = byInvoice.get(ret.invoiceId) ?? { lines: [], refunds: [] };
    for (const l of ret.lines) {
      bucket.lines.push({
        invoiceId: ret.invoiceId,
        invoiceLineId: l.invoiceLineId,
        productId: l.productId,
        quantity: l.quantity,
        condition: l.condition,
      });
    }
    // Only a REFUNDED return has actually paid money back. A RECEIVED one may
    // carry an agreed amount that has not been handed over yet, and counting
    // it would understate what we still owe.
    if (ret.status === "REFUNDED") {
      bucket.refunds.push({ refundAmount: ret.refundAmount });
    }
    byInvoice.set(ret.invoiceId, bucket);
  }

  return byInvoice;
}

/** Convenience for the single-invoice case (the invoice detail screen). */
export async function invoiceReturnSummary(
  client: Client,
  companyId: string,
  invoice: InvoiceLike
): Promise<InvoiceReturnSummary> {
  const found = await loadSettledReturns(client, companyId, [invoice.id]);
  const bucket = found.get(invoice.id);
  if (!bucket) return emptyReturnSummary();
  return summariseInvoiceReturns(invoice, bucket.lines, bucket.refunds);
}
