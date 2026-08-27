/**
 * Paperwork rules for the item register.
 */
import { z } from "zod";

const baseProductSchema = z.object({
  sku: z.string().trim().min(1, "SKU is required"), // the item's label code
  barcode: z.string().trim().optional(), // scannable code (B1)
  name: z.string().trim().min(2, "Name is too short"),
  description: z.string().trim().optional(),
  hsnCode: z.string().trim().max(20).optional(),
  categoryId: z.string().optional(),
  preferredSupplierId: z.string().optional(),
  unit: z.string().trim().min(1).default("pcs"),
  // How many decimal places this product's quantities may use (P1-2).
  // 0 = whole units (staplers); 3 = grams on a kg-stocked product.
  // Capped at 4 because that's the column's scale — promising more would be
  // a lie the database silently rounds away.
  precision: z
    .number()
    .int("Precision must be a whole number")
    .min(0)
    .max(4, "At most 4 decimal places are stored")
    .default(0),
  // Optional purchase pack: "1 box = 12 pcs". Both or neither.
  packUnit: z.string().trim().min(1).max(30).optional(),
  unitsPerPack: z.number().positive("A pack must contain more than zero").optional(),
  costPrice: z.number().nonnegative("Cost can't be negative").default(0),
  sellingPrice: z.number().nonnegative("Price can't be negative").default(0),
  // Decimal since P1-2 — a 0.5 kg threshold is as valid as a 5-piece one.
  lowStockThreshold: z.number().nonnegative().default(0),
  tracksBatch: z.boolean().default(false),
  // Which lot leaves first when this product is sold. Only consulted when
  // tracksBatch is on. FEFO (nearest expiry first) is the safe default —
  // FIFO only makes sense for goods that never expire.
  batchStrategy: z.enum(["FEFO", "FIFO"]).default("FEFO"),
});

/** A pack is only meaningful with both a name and a size — reject half of one. */
export const createProductSchema = baseProductSchema
  .refine((d) => !(d.packUnit && d.unitsPerPack === undefined), {
    message: "Say how many units are in one pack",
    path: ["unitsPerPack"],
  })
  .refine((d) => !(d.unitsPerPack !== undefined && !d.packUnit), {
    message: "Name the pack unit (e.g. box)",
    path: ["packUnit"],
  });

// For editing: same fields, but ALL optional — send only what changes.
// isActive lets us reactivate a retired product.
// Built from the BASE schema because .partial() can't be applied to a
// refined object — the refinements are re-attached on the way out.
export const updateProductSchema = baseProductSchema
  .partial()
  .extend({ isActive: z.boolean().optional() });

// For list filters arriving in the URL, like /api/products?search=pen
// URL values are always text, so coerce turns "true" into true.
export const listProductsQuerySchema = z.object({
  search: z.string().trim().optional(),
  categoryId: z.string().optional(),
  includeInactive: z.coerce.boolean().default(false),
  // Pagination: one page at a time, never the whole catalog.
  take: z.coerce.number().int().min(1).max(500).default(25),
  skip: z.coerce.number().int().min(0).default(0),
});

// CSV import — one row. Numbers arrive as strings, so coerce them.
export const importRowSchema = z.object({
  sku: z.string().trim().min(1, "SKU is required"),
  name: z.string().trim().min(2, "Name is too short"),
  barcode: z.string().trim().optional(),
  // Defaults (not just optional) so the output matches CreateProductInput.
  unit: z.string().trim().min(1).default("pcs"),
  costPrice: z.coerce.number().nonnegative().default(0),
  sellingPrice: z.coerce.number().nonnegative().default(0),
  lowStockThreshold: z.coerce.number().nonnegative().default(0),
  tracksBatch: z.coerce.boolean().default(false),
  batchStrategy: z.enum(["FEFO", "FIFO"]).default("FEFO"),
  // Importable too (P1-2) — a spreadsheet of goods sold by weight would
  // otherwise land as whole-units-only and reject every fractional movement
  // afterwards, with no obvious cause.
  precision: z.coerce.number().int().min(0).max(4).default(0),
  packUnit: z.string().trim().min(1).max(30).optional(),
  unitsPerPack: z.coerce.number().positive().optional(),
});
export const importProductsSchema = z.object({
  rows: z.array(z.record(z.string(), z.any())).min(1).max(1000),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
