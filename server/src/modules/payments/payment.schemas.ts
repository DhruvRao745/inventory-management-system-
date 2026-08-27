/**
 * Paperwork rules for payments (P1-5).
 *
 * Note what is NOT here: any check that the amount fits within the invoice's
 * balance. Zod validates one request in isolation; whether ₹500 overpays
 * depends on every other payment against that invoice, which only the service
 * can see — and only while holding a lock, or two simultaneous payments would
 * both look fine and together overpay.
 */
import { z } from "zod";

export const PAYMENT_METHODS = [
  "CASH",
  "UPI",
  "CARD",
  "BANK_TRANSFER",
  "OTHER",
] as const;

export const createPaymentSchema = z.object({
  invoiceId: z.string().min(1, "Which invoice is this for?"),
  amount: z
    .number()
    .positive("A payment must be more than zero")
    .max(99_999_999, "That amount looks like a typo"),
  method: z.enum(PAYMENT_METHODS).default("CASH"),
  // Defaults to now in the database. Supplied explicitly when money arrived on
  // a different day from the day it was keyed in — a cheque banked Friday and
  // recorded Monday belongs to Friday.
  paymentDate: z.string().datetime({ message: "Use ISO datetime" }).optional(),
  reference: z.string().trim().max(100).optional(), // UPI ref, cheque no.
  notes: z.string().trim().max(500).optional(),
});

export const listPaymentsQuerySchema = z.object({
  invoiceId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  take: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;
