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
    //
    // No .int() since P1-2: 2.5 kg is a legitimate quantity. Whether THIS
    // product may have decimals is decided by Product.precision, checked
    // server-side in lib/quantity.ts — Zod can't know which product this is.
    // Accepts a string too, so a client can send "2.5" without a float
    // round-trip mangling it.
    quantity: z.union([z.number(), z.string().trim().min(1)]),
    /**
     * What CONDITION this stock is in (P2-2). Defaults to AVAILABLE.
     *
     * Only meaningful on INCOMING stock — you receive goods into quarantine,
     * or book a damaged return into the damaged bucket. Outgoing movements
     * take their status from the stock they consume, not from the request,
     * which is why the service overrides this for sales.
     */
    status: z
      .enum(["AVAILABLE", "DAMAGED", "QUARANTINE", "EXPIRED"])
      .optional(),
    unitCost: z.number().nonnegative().optional(),
    reference: z.string().trim().optional(), // invoice / PO number
    note: z.string().trim().optional(),
    // Batch/expiry — captured on incoming stock for batch-tracked products (F3)
    batchNumber: z.string().trim().optional(),
    expiryDate: z.string().datetime().optional(),
  })
  .superRefine((data, ctx) => {
    // Shape-level checks only. Value-level rules that need the PRODUCT
    // (precision, zero, sign) live in lib/quantity.ts — see parseQuantity.
    const n = Number(data.quantity);
    if (!Number.isFinite(n)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quantity"],
        message: "Quantity must be a number",
      });
      return;
    }
    if (n === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quantity"],
        message: "Quantity can't be zero",
      });
    }
    if (data.type !== "ADJUSTMENT" && n < 0) {
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
    // Decimal-capable since P1-2; per-product precision checked server-side.
    quantity: z.union([z.number().positive(), z.string().trim().min(1)]),
    note: z.string().trim().optional(),
  })
  .refine((d) => d.fromLocationId !== d.toLocationId, {
    message: "Source and destination must be different",
    path: ["toLocationId"],
  });

export const listMovementsQuerySchema = z.object({
  productId: z.string().optional(),
  locationId: z.string().optional(),
  // Reading the diary, we CAN filter by transfer rows too (unlike writing).
  type: z
    .enum([
      "PURCHASE",
      "SALE",
      "RETURN_IN",
      "RETURN_OUT",
      "ADJUSTMENT",
      "TRANSFER_IN",
      "TRANSFER_OUT",
    ])
    .optional(),
  // Date window — client sends ISO instants (it knows the user's timezone).
  from: z.string().datetime({ message: "Use ISO datetime" }).optional(),
  to: z.string().datetime({ message: "Use ISO datetime" }).optional(),
  // Pagination: don't dump 100,000 diary lines in one response.
  take: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export const levelsQuerySchema = z.object({
  locationId: z.string().optional(),
  productId: z.string().optional(),
});

/**
 * Batch listing (P1-1).
 *
 * `expiringInDays` is the practical question a shop actually asks — "what
 * goes off this month?" — so we take a day count and turn it into a date
 * here rather than making every caller compute one.
 */
export const batchQuerySchema = z.object({
  productId: z.string().optional(),
  locationId: z.string().optional(),
  includeEmpty: z.coerce.boolean().optional(),
  expiringInDays: z.coerce.number().int().min(0).max(3650).optional(),
});

const stockStatusEnum = z.enum([
  "AVAILABLE",
  "DAMAGED",
  "QUARANTINE",
  "EXPIRED",
]);

/**
 * Moving stock between conditions (P2-2) — quarantine released, goods found
 * broken, expired stock written off.
 */
export const reclassifySchema = z
  .object({
    productId: z.string().min(1),
    locationId: z.string().min(1),
    // Always positive: this is "move 5 units across", never a signed delta.
    // The service writes the negative half itself.
    quantity: z.union([z.number().positive(), z.string().trim().min(1)]),
    fromStatus: stockStatusEnum,
    toStatus: stockStatusEnum,
    note: z.string().trim().max(300).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.fromStatus === data.toStatus) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toStatus"],
        message: "Choose a different status to move the stock to",
      });
    }
  });

export type ReclassifyInput = z.infer<typeof reclassifySchema>;
export type CreateMovementInput = z.infer<typeof createMovementSchema>;
export type TransferInput = z.infer<typeof transferSchema>;
export type ListMovementsQuery = z.infer<typeof listMovementsQuerySchema>;
export type LevelsQuery = z.infer<typeof levelsQuerySchema>;
export type BatchQuery = z.infer<typeof batchQuerySchema>;
