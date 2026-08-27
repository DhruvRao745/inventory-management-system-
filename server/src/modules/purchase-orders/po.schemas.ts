/**
 * Validation for purchase orders. A PO is a supplier + one-or-more lines
 * (product, quantity, unit cost). The server owns the PO number and status.
 */
import { z } from "zod";

const lineSchema = z.object({
  productId: z.string().min(1),
  // Decimal-capable since P1-2; per-product precision checked in the service.
  quantity: z.union([z.number().positive(), z.string().trim().min(1)]),
  unitCost: z.number().nonnegative("Unit cost can't be negative"),
});

export const createPOSchema = z.object({
  supplierId: z.string().min(1, "Pick a supplier"),
  notes: z.string().trim().optional(),
  // ISO instant — the browser knows the user's timezone, we don't.
  expectedDate: z.string().datetime().optional(),
  lines: z.array(lineSchema).min(1, "Add at least one line"),
});

// Draft edits: any field may be omitted; expectedDate may be cleared (null).
export const updatePOSchema = z.object({
  supplierId: z.string().min(1).optional(),
  notes: z.string().trim().nullable().optional(),
  expectedDate: z.string().datetime().nullable().optional(),
  lines: z.array(lineSchema).min(1, "Add at least one line").optional(),
});

// The only status moves a user can request. DRAFT→ORDERED "places" the PO;
// either state can be CANCELLED. (RECEIVED is Phase 3, via the stock flow.)
export const statusChangeSchema = z.object({
  status: z.enum(["ORDERED", "CANCELLED"]),
});

// Receiving (Phase 3): how many of each line arrived, into which location.
export const receiveSchema = z.object({
  locationId: z.string().min(1, "Pick a location"),
  notes: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        lineId: z.string().min(1),
        /** Goods we're taking in — the only quantity that enters stock. */
        quantity: z.union([z.number().positive(), z.string().trim().min(1)]),
        /**
         * Goods that turned up but were refused (broken, wrong item,
         * short-dated). Recorded so the supplier can be chased, but never
         * becomes inventory and never counts towards fulfilling the order.
         */
        rejectedQty: z
          .union([z.number().nonnegative(), z.string().trim().min(1)])
          .optional(),
        rejectReason: z.string().trim().max(300).optional(),
        /**
         * What we were ACTUALLY charged, if it differs from the quoted price.
         * Feeds the weighted average — inventory is worth what you paid, not
         * what you expected to pay. Falls back to the PO line's unitCost.
         */
        actualUnitCost: z.number().nonnegative().optional(),
        // Batch details, captured at the moment goods arrive — the only
        // point where anyone actually has the carton in hand to read them.
        // Required for batch-tracked products (enforced in the service, which
        // is where we know whether the product tracks batches).
        batchNumber: z.string().trim().min(1).max(60).optional(),
        manufactureDate: z.string().datetime().optional(),
        expiryDate: z.string().datetime().optional(),
      })
    )
    .min(1, "Receive at least one item"),
});

export const listPOQuerySchema = z.object({
  status: z
    .enum(["DRAFT", "ORDERED", "PARTIAL", "RECEIVED", "CANCELLED"])
    .optional(),
  supplierId: z.string().optional(),
  number: z.coerce.number().int().positive().optional(),
  take: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export type CreatePOInput = z.infer<typeof createPOSchema>;
export type UpdatePOInput = z.infer<typeof updatePOSchema>;
export type ListPOQuery = z.infer<typeof listPOQuerySchema>;
export type ReceiveInput = z.infer<typeof receiveSchema>;
