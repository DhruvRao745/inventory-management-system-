/**
 * Paperwork rules for diary entries.
 *
 * Note: the client can only ask for these five types. TRANSFER_IN and
 * TRANSFER_OUT are NOT here on purpose — transfers have their own door
 * (/transfer) because they always come as a pair.
 */
import { z } from "zod";

export const createMovementSchema = z
  .object({
    productId: z.string().min(1),
    locationId: z.string().min(1),
    type: z.enum(["PURCHASE", "SALE", "RETURN_IN", "RETURN_OUT", "ADJUSTMENT"]),
    // Always positive — "sold 3", never "-3". The SERVER decides the sign.
    // Exception: ADJUSTMENT may be negative ("found 2 broken" = -2).
    quantity: z.number().int("Whole numbers only"),
    unitCost: z.number().nonnegative().optional(),
    reference: z.string().trim().optional(), // invoice / PO number
    note: z.string().trim().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.quantity === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quantity"],
        message: "Quantity can't be zero",
      });
    }
    if (data.type !== "ADJUSTMENT" && data.quantity < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quantity"],
        message: "Send a positive quantity — the type decides the direction",
      });
    }
  });

export const transferSchema = z
  .object({
    productId: z.string().min(1),
    fromLocationId: z.string().min(1),
    toLocationId: z.string().min(1),
    quantity: z.number().int().positive("Quantity must be positive"),
    note: z.string().trim().optional(),
  })
  .refine((d) => d.fromLocationId !== d.toLocationId, {
    message: "Source and destination must be different",
    path: ["toLocationId"],
  });

export const listMovementsQuerySchema = z.object({
  productId: z.string().optional(),
  locationId: z.string().optional(),
  // Pagination: don't dump 100,000 diary lines in one response.
  take: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export const levelsQuerySchema = z.object({
  locationId: z.string().optional(),
  productId: z.string().optional(),
});

export type CreateMovementInput = z.infer<typeof createMovementSchema>;
export type TransferInput = z.infer<typeof transferSchema>;
export type ListMovementsQuery = z.infer<typeof listMovementsQuerySchema>;
export type LevelsQuery = z.infer<typeof levelsQuerySchema>;
