/**
 * Point of sale (P3-4) — validation.
 *
 * Note what is NOT here: no stock fields, no cost fields, no tax fields beyond
 * the two that pick a regime. A till says WHAT was sold and HOW it was paid
 * for. Everything else — the price if not overridden, the tax, the cost of
 * goods, the stock deduction — is decided by the same code that decides it for
 * an invoice typed in by hand.
 */
import { z } from "zod";
import { PAYMENT_METHODS } from "../payments/payment.schemas.js";

const posLineSchema = z.object({
  productId: z.string().min(1),
  quantity: z.union([z.number().positive(), z.string().trim().min(1)]),
  /**
   * Optional. Left out, the server uses the product's selling price.
   *
   * The DEFAULT has to come from the server. If the till sent the price it
   * read from the catalogue, then a stale tab, a cached page or a tampered
   * request would sell at yesterday's price — and it would look completely
   * ordinary in the invoice afterwards.
   *
   * An explicit override is still allowed, because haggling at a counter is
   * real. It is recorded on the line like any other price, so a discount is
   * visible rather than hidden in a total.
   */
  unitPrice: z.number().nonnegative().optional(),
  gstRate: z.number().min(0).max(100).optional(),
});

const posPaymentSchema = z.object({
  method: z.enum(PAYMENT_METHODS).default("CASH"),
  /**
   * What the customer handed over. Optional: left out, it means "the exact
   * amount due", which is the overwhelmingly common case and saves the till
   * recomputing a total the server is about to compute anyway.
   */
  amount: z.number().positive().optional(),
  reference: z.string().trim().max(100).optional(),
});

export const posSaleSchema = z.object({
  locationId: z.string().min(1, "Which till/location is this?"),
  lines: z.array(posLineSchema).min(1, "Scan at least one item"),

  // Walk-in by default — a counter sale usually has no named customer.
  customerId: z.string().optional(),
  customerName: z.string().trim().min(1).optional(),
  customerPhone: z.string().trim().optional(),
  customerGstin: z.string().trim().max(20).optional(),

  useGst: z.boolean().optional(),
  placeOfSupply: z.string().trim().length(2).optional(),
  discount: z.number().nonnegative().optional(),
  taxRate: z.number().min(0).max(100).optional(),

  /**
   * Omit for "on account" — an issued, unpaid invoice, exactly as if it had
   * been raised from the Invoices screen. The till is not obliged to take
   * money; a staff purchase or a known customer's tab is a normal sale that
   * simply has not been paid yet.
   */
  payment: posPaymentSchema.optional(),
  notes: z.string().trim().max(500).optional(),
});

export type PosSaleInput = z.infer<typeof posSaleSchema>;
