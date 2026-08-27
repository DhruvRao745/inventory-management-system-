/**
 * Paperwork rules for stock counts (P1-9).
 */
import { z } from "zod";

export const createCountSchema = z.object({
  locationId: z.string().min(1, "Which location are you counting?"),
  /**
   * Count only these products. Omit to sweep the whole location.
   * A targeted list includes named products even at zero stock — "we think
   * there are none, confirm that" is a legitimate thing to ask.
   */
  productIds: z.array(z.string().min(1)).optional(),
  /**
   * Include products the system believes are at zero. Off by default: a sheet
   * listing 2,000 products the shop has never carried is a sheet nobody will
   * finish.
   */
  includeZeroStock: z.boolean().optional(),
  notes: z.string().trim().max(500).optional(),
});

export const recordCountSchema = z.object({
  itemId: z.string().min(1),
  // Zero is valid and meaningful — an empty shelf is a real finding, and
  // different from "nobody has looked yet" (which is null).
  countedQuantity: z.union([z.number().nonnegative(), z.string().trim().min(1)]),
  notes: z.string().trim().max(300).optional(),
});

export const listCountsQuerySchema = z.object({
  status: z
    .enum(["OPEN", "COUNTING", "REVIEW", "COMPLETED", "CANCELLED"])
    .optional(),
  locationId: z.string().optional(),
  take: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export type CreateCountInput = z.infer<typeof createCountSchema>;
export type RecordCountInput = z.infer<typeof recordCountSchema>;
export type ListCountsQuery = z.infer<typeof listCountsQuerySchema>;
