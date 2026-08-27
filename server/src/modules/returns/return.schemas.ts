/**
 * Paperwork rules for sales returns (P1-6).
 */
import { z } from "zod";

export const RETURN_CONDITIONS = ["SELLABLE", "DAMAGED", "QUARANTINE"] as const;

const returnLineSchema = z
  .object({
    invoiceLineId: z.string().min(1),
    // Decimal-capable; per-product precision is checked in the service.
    quantity: z.union([z.number().positive(), z.string().trim().min(1)]),
    condition: z.enum(RETURN_CONDITIONS).default("SELLABLE"),
    /**
     * Whether these units go back into sellable stock.
     *
     * Defaults to true, but see the refinement below: only SELLABLE goods may
     * ever be restocked. You can decline to restock good stock; you cannot
     * restock broken stock.
     */
    restock: z.boolean().default(true),
    notes: z.string().trim().max(300).optional(),
  })
  .refine((l) => !(l.restock && l.condition !== "SELLABLE"), {
    message:
      "Only goods in sellable condition can go back into stock — mark them not-restocked",
    path: ["restock"],
  });

export const createReturnSchema = z.object({
  invoiceId: z.string().min(1, "Which invoice is this against?"),
  reason: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(500).optional(),
  lines: z.array(returnLineSchema).min(1, "Return at least one item"),
});

/** Only the paperwork is editable, and only before the goods arrive. */
export const updateReturnSchema = z.object({
  reason: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(500).optional(),
  refundAmount: z.number().nonnegative().optional(),
});

export const listReturnsQuerySchema = z.object({
  status: z
    .enum(["REQUESTED", "APPROVED", "RECEIVED", "REFUNDED", "CANCELLED"])
    .optional(),
  invoiceId: z.string().optional(),
  number: z.coerce.number().int().positive().optional(),
  take: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export const refundSchema = z.object({
  refundAmount: z.number().nonnegative("A refund can't be negative"),
});

export type CreateReturnInput = z.infer<typeof createReturnSchema>;
export type UpdateReturnInput = z.infer<typeof updateReturnSchema>;
export type ListReturnsQuery = z.infer<typeof listReturnsQuerySchema>;
export type RefundInput = z.infer<typeof refundSchema>;
