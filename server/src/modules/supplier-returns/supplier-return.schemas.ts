/**
 * Paperwork rules for supplier returns (P1-7).
 */
import { z } from "zod";

const lineSchema = z.object({
  productId: z.string().min(1),
  quantity: z.union([z.number().positive(), z.string().trim().min(1)]),
  unitCost: z.number().nonnegative().optional(),
  /**
   * Which receipt line these units arrived on, where we know it.
   * PRD §10 asks the return to reference the original receiving where
   * possible — it's how "which delivery was this from?" gets an answer.
   */
  goodsReceiptLineId: z.string().optional(),
  notes: z.string().trim().max(300).optional(),
});

export const createSupplierReturnSchema = z.object({
  supplierId: z.string().min(1, "Which supplier is this going back to?"),
  locationId: z.string().min(1, "Which location are the goods leaving from?"),
  goodsReceiptId: z.string().optional(),
  reason: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(500).optional(),
  lines: z.array(lineSchema).min(1, "Return at least one item"),
});

export const updateSupplierReturnSchema = z.object({
  reason: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(500).optional(),
});

export const listSupplierReturnsQuerySchema = z.object({
  status: z.enum(["DRAFT", "SENT", "COMPLETED", "CANCELLED"]).optional(),
  supplierId: z.string().optional(),
  number: z.coerce.number().int().positive().optional(),
  take: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export type CreateSupplierReturnInput = z.infer<
  typeof createSupplierReturnSchema
>;
export type UpdateSupplierReturnInput = z.infer<
  typeof updateSupplierReturnSchema
>;
export type ListSupplierReturnsQuery = z.infer<
  typeof listSupplierReturnsQuerySchema
>;
