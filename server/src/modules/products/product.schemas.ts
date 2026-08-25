/**
 * Paperwork rules for the item register.
 */
import { z } from "zod";

export const createProductSchema = z.object({
  sku: z.string().trim().min(1, "SKU is required"), // the item's label code
  barcode: z.string().trim().optional(), // scannable code (B1)
  name: z.string().trim().min(2, "Name is too short"),
  description: z.string().trim().optional(),
  hsnCode: z.string().trim().max(20).optional(),
  categoryId: z.string().optional(),
  preferredSupplierId: z.string().optional(),
  unit: z.string().trim().min(1).default("pcs"),
  costPrice: z.number().nonnegative("Cost can't be negative").default(0),
  sellingPrice: z.number().nonnegative("Price can't be negative").default(0),
  lowStockThreshold: z
    .number()
    .int("Must be a whole number")
    .nonnegative()
    .default(0),
  tracksBatch: z.boolean().default(false),
});

// For editing: same fields, but ALL optional — send only what changes.
// isActive lets us reactivate a retired product.
export const updateProductSchema = createProductSchema
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
  lowStockThreshold: z.coerce.number().int().nonnegative().default(0),
  tracksBatch: z.coerce.boolean().default(false),
});
export const importProductsSchema = z.object({
  rows: z.array(z.record(z.string(), z.any())).min(1).max(1000),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
