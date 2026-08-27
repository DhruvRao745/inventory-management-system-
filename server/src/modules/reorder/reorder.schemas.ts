/**
 * Paperwork rules for per-location reorder settings (P1-8).
 */
import { z } from "zod";

export const upsertSettingSchema = z.object({
  productId: z.string().min(1),
  locationId: z.string().min(1),
  // All optional — each one that's absent falls back to the product default,
  // which is what makes this feature additive rather than a migration.
  minQuantity: z.number().nonnegative().optional(),
  maxQuantity: z.number().nonnegative().optional(),
  reorderQuantity: z.number().positive().optional(),
  preferredSupplierId: z.string().optional(),
});

export const listSettingsQuerySchema = z.object({
  productId: z.string().optional(),
  locationId: z.string().optional(),
});

export const reorderQuerySchema = z.object({
  locationId: z.string().optional(),
});

export type UpsertSettingInput = z.infer<typeof upsertSettingSchema>;
export type ListSettingsQuery = z.infer<typeof listSettingsQuerySchema>;
export type ReorderQuery = z.infer<typeof reorderQuerySchema>;
