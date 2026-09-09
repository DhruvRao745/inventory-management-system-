/**
 * Point of sale (P3-4).
 *
 * THIS FILE COMPOSES. IT DOES NOT IMPLEMENT.
 *
 * The spec is one sentence: "POS sales must use the same inventory, pricing,
 * tax, payment and stock-movement logic as normal sales. Do not create a
 * separate inventory system for POS."
 *
 * So a till sale is three existing calls in a row:
 *
 *     createInvoice()  →  issueInvoice()  →  recordPayment()
 *
 * and nothing else. No stock is written here, no tax is computed here, no cost
 * is stamped here. Search this file for `stockMovement`, `avgCost` or `cgst`
 * and you will find none of them — that is the design, not an omission.
 *
 * WHY THAT MATTERS MORE THAN IT SOUNDS
 *
 * A POS is where a second inventory system gets born. The pressure is real:
 * the till needs to be fast, the invoice screen has fields a counter doesn't
 * want, and writing a movement directly is three lines instead of a service
 * call. Take that shortcut and you get two code paths that both deduct stock,
 * and every rule added afterwards — oversell guards, batch selection, GST,
 * reservations, costing — has to be remembered twice. The second one silently
 * rots. Six months later the shop's counter sales don't appear in COGS and
 * nobody can say when that started.
 *
 * The composition costs a few hundred milliseconds and buys the guarantee that
 * a counter sale and a typed invoice cannot drift apart, because they are the
 * same code.
 */
import { AppError } from "../../middleware/error.js";
import { prisma } from "../../lib/prisma.js";
import {
  cancelInvoice,
  createInvoice,
  issueInvoice,
  getInvoice,
} from "../invoices/inv.service.js";
import { recordPayment } from "../payments/payment.service.js";
import { invoiceTotalDecimal } from "../../lib/money.js";
import { Prisma } from "@prisma/client";
import { computeInvoiceGst } from "../../lib/gst.js";
import type { PosSaleInput, PosQuoteInput } from "./pos.schemas.js";

/** What a basket will cost — the figure the cashier says out loud (BUG-11). */
export type PosQuoteResult = {
  subtotal: number;
  tax: number;
  total: number;
  /** Whether any tax is included in `total`. */
  taxed: boolean;
  /** True when a line has no GST rate decided, so no honest total exists. */
  unrated?: boolean;
};

export type PosSaleResult = {
  invoice: Awaited<ReturnType<typeof getInvoice>>;
  /** What was taken, if anything. Null for an on-account sale. */
  payment: { amount: number; method: string; change: number } | null;
  /** Still owed after this payment. Zero on a normal completed sale. */
  balance: number;
};

/**
 * Ring up a sale.
 *
 * ATOMICITY: DELIBERATELY NOT ONE TRANSACTION.
 *
 * The three services each own their own transaction, and this does not try to
 * wrap them in a fourth. That looks like a gap. It is a decision, and the
 * reason is physical rather than technical.
 *
 * If taking payment fails, one transaction would roll the whole thing back —
 * including the stock deduction. But at a counter the goods are already in the
 * customer's bag. Un-selling them would make the ledger disagree with the
 * shelf, which is the one thing this system exists to prevent. The stock left;
 * that is a fact, and facts are not rolled back because a later step failed.
 *
 * What we get instead is an ISSUED, UNPAID invoice — not a corruption but an
 * ordinary state the system already models, already displays, and already
 * knows how to collect against. The operator sees the error, opens the
 * invoice, and takes the payment again. Nothing is lost and nothing is
 * double-counted.
 *
 * The one danger is a blind retry of the WHOLE sale, which would deduct stock
 * twice. So a failure after issuing reports the invoice it already created and
 * says plainly what remains to be done.
 */
export async function posSale(
  companyId: string,
  userId: string,
  input: PosSaleInput
): Promise<PosSaleResult> {
  // --- 1. Resolve prices from the catalogue ----------------------------
  //
  // The till may override a price, but the DEFAULT is read here, server-side,
  // at the moment of sale. A price sent up from the browser would be whatever
  // that tab loaded — possibly hours ago, possibly edited — and the resulting
  // invoice would look entirely normal afterwards.
  const products = await prisma.product.findMany({
    where: { id: { in: input.lines.map((l) => l.productId) }, companyId },
    select: { id: true, sellingPrice: true, isActive: true, name: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  const lines = input.lines.map((l) => {
    const p = byId.get(l.productId);
    if (!p) throw new AppError(400, "Unknown product on this sale");
    if (!p.isActive) {
      throw new AppError(400, `${p.name} is retired and can't be sold`);
    }
    return {
      productId: l.productId,
      quantity: l.quantity,
      unitPrice: l.unitPrice ?? Number(p.sellingPrice),
      ...(l.gstRate !== undefined ? { gstRate: l.gstRate } : {}),
    };
  });

  // --- 2. The invoice, through the ordinary path ------------------------
  //
  // Marked POS by the fourth argument, which the HTTP layer cannot set. Every
  // rule createInvoice enforces — numbering under lock, location and product
  // ownership, quantity precision, GST stamping, reservations — applies here
  // untouched.
  const draft = await createInvoice(
    companyId,
    userId,
    {
      customerId: input.customerId,
      customerName: input.customerName?.trim() || "Walk-in customer",
      customerPhone: input.customerPhone,
      customerGstin: input.customerGstin,
      notes: input.notes,
      useGst: input.useGst,
      placeOfSupply: input.placeOfSupply,
      discount: input.discount,
      taxRate: input.taxRate,
      locationId: input.locationId,
      lines,
    },
    "POS"
  );

  // --- 3. Issue it: this is what moves stock ---------------------------
  //
  // The oversell guard, the advisory locks, FEFO batch selection and the
  // stamped weighted-average cost all live in here. A till that wrote its own
  // stock movement would have none of them.
  try {
    await issueInvoice(companyId, userId, draft.id);
  } catch (err) {
    /**
     * The draft RESERVED its lines the moment it was created, and a draft
     * that never issues keeps holding them. So a till sale that fails the
     * oversell guard used to leave the shelf permanently short by the amount
     * it tried to sell: the second attempt then failed too, for stock the
     * first attempt was still sitting on, and the only symptom was a shop
     * that could not sell its own goods.
     *
     * Rolling back here is safe in a way that rolling back a PAYMENT is not
     * (see the note above): issueInvoice failed, so NO stock moved and
     * nothing has left the counter. There is no physical fact to contradict —
     * only a piece of paperwork that never became a sale.
     *
     * Cancelling is best-effort: if it fails, the original error is still
     * what the operator needs to see, and a stranded draft is visible and
     * cancellable in the invoice list.
     */
    await cancelInvoice(companyId, userId, draft.id).catch(() => undefined);
    throw err;
  }

  const issued = await getInvoice(companyId, draft.id);
  if (!issued) throw new AppError(500, "Sale was issued but could not be read");

  const total = Number(invoiceTotalDecimal(issued).toDecimalPlaces(2));

  // --- 4. Payment, if the customer is paying now -----------------------
  if (!input.payment) {
    return { invoice: issued, payment: null, balance: total };
  }

  // Tendered cash can exceed the bill; the difference is change, not an
  // overpayment to be recorded. Recording ₹500 against a ₹380 bill would leave
  // the invoice permanently ₹120 in credit for money that went back across the
  // counter in coins.
  const tendered = input.payment.amount ?? total;
  const applied = Math.min(tendered, total);
  const change = Math.round((tendered - applied) * 100) / 100;

  if (applied > 0) {
    try {
      await recordPayment(companyId, userId, {
        invoiceId: issued.id,
        amount: applied,
        method: input.payment.method,
        reference: input.payment.reference,
      });
    } catch (err) {
      // The goods have gone. Say exactly what exists so the operator settles
      // the invoice that is already there instead of ringing the sale again.
      const msg = err instanceof AppError ? err.message : "payment failed";
      throw new AppError(
        409,
        `Sale ${invoiceLabel(issued.number)} was completed and stock was ` +
          `deducted, but the payment was not recorded (${msg}). Open the ` +
          `invoice and take payment there — do NOT ring this sale again.`
      );
    }
  }

  const settled = await getInvoice(companyId, issued.id);
  return {
    invoice: settled ?? issued,
    payment: {
      amount: applied,
      method: input.payment.method,
      change,
    },
    balance: Math.round((total - applied) * 100) / 100,
  };
}

function invoiceLabel(n: number) {
  return `INV-${String(n).padStart(4, "0")}`;
}

/**
 * What will this basket cost, including tax? (BUG-11)
 *
 * WHY THIS EXISTS
 *
 * The till used to show the pre-tax subtotal on its "Take ₹…" button while the
 * invoice charged the tax-inclusive total. On a ₹200 basket at 5% GST the
 * cashier was told to collect ₹200 and the books recorded ₹210 received — the
 * drawer came up short on every GST sale, and nothing on screen said why.
 *
 * The screen cannot fix that by itself. Working GST out in the browser would
 * be a second tax engine, and there is a comment in `client/src/lib/gst.ts`
 * explaining exactly why there must not be one. So the till asks the server,
 * and the server answers with the SAME function that will stamp the invoice a
 * moment later — `computeInvoiceGst`. One engine, asked twice.
 *
 * WRITES NOTHING. No invoice, no reservation, no number burned. A price check
 * is not a sale, and a cashier who changes their mind must not leave a trail.
 *
 * The prices come from the catalogue for the same reason they do in posSale:
 * a total quoted from what the browser happened to have loaded is a total that
 * can disagree with what is charged.
 */
export async function posQuote(
  companyId: string,
  input: PosQuoteInput
): Promise<PosQuoteResult> {
  const empty: PosQuoteResult = {
    subtotal: 0,
    tax: 0,
    total: 0,
    taxed: false,
  };
  if (input.lines.length === 0) return empty;

  const [products, company] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: input.lines.map((l) => l.productId) }, companyId },
      select: {
        id: true,
        name: true,
        sellingPrice: true,
        gstRate: true,
        isActive: true,
      },
    }),
    prisma.company.findUnique({
      where: { id: companyId },
      select: { stateCode: true },
    }),
  ]);
  const byId = new Map(products.map((p) => [p.id, p]));

  const priced = input.lines.map((l) => {
    const p = byId.get(l.productId);
    if (!p) throw new AppError(400, "Unknown product on this sale");
    return {
      quantity: new Prisma.Decimal(l.quantity),
      unitPrice: new Prisma.Decimal(l.unitPrice ?? Number(p.sellingPrice)),
      gstRate:
        l.gstRate !== undefined
          ? new Prisma.Decimal(l.gstRate)
          : p.gstRate,
    };
  });

  const subtotal = priced
    .reduce(
      (s, l) => s.plus(l.unitPrice.times(l.quantity)),
      new Prisma.Decimal(0)
    )
    .toDecimalPlaces(2);
  const discount = new Prisma.Decimal(input.discount ?? 0);

  // Not a GST sale: the subtotal (less any discount) IS what the customer
  // pays, so there is nothing to work out and nothing to get wrong.
  if (!input.useGst) {
    const flat = subtotal
      .minus(discount)
      .plus(
        input.taxRate
          ? subtotal.minus(discount).times(input.taxRate).dividedBy(100)
          : 0
      )
      .toDecimalPlaces(2);
    return {
      subtotal: Number(subtotal),
      tax: Number(flat.minus(subtotal.minus(discount)).toDecimalPlaces(2)),
      total: Number(flat),
      taxed: Boolean(input.taxRate),
    };
  }

  // A line with no rate decided is refused at the moment of sale, and the
  // screen blocks it too. Quoting one would mean guessing a rate, which is the
  // one thing this system will not do about tax — so say so instead.
  if (priced.some((l) => l.gstRate === null)) {
    return { ...empty, subtotal: Number(subtotal), unrated: true };
  }

  // A walk-in has no address, so the place of supply is our own state — the
  // same answer resolvePlaceOfSupply gives when nothing else is known.
  const breakup = computeInvoiceGst({
    lines: priced,
    discount,
    sellerStateCode: company?.stateCode ?? null,
    placeOfSupply: input.placeOfSupply ?? company?.stateCode ?? null,
  });

  return {
    subtotal: Number(breakup.subtotal),
    tax: Number(breakup.totalTax),
    total: Number(breakup.grandTotal),
    taxed: true,
  };
}
