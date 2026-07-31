/**
 * Validation for customer invoices. An invoice is a customer + one-or-more
 * lines (product, quantity, unit price), sold out of one location. The server
 * owns the number and status; issuing deducts stock.
 */
import { z } from "zod";

const lineSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().positive("Quantity must be at least 1"),
  unitPrice: z.number().nonnegative("Price can't be negative"),
});

export const createInvoiceSchema = z.object({
  customerId: z.string().optional(), // optional link to a saved customer
  customerName: z.string().trim().min(1, "Customer name is required"),
  customerPhone: z.string().trim().optional(),
  customerAddress: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  taxRate: z.number().min(0).max(100).optional(),
  discount: z.number().nonnegative().optional(),
  locationId: z.string().min(1, "Pick a location"),
  lines: z.array(lineSchema).min(1, "Add at least one line"),
});

export const updateInvoiceSchema = z.object({
  customerId: z.string().nullable().optional(),
  customerName: z.string().trim().min(1).optional(),
  customerPhone: z.string().trim().nullable().optional(),
  customerAddress: z.string().trim().nullable().optional(),
  notes: z.string().trim().nullable().optional(),
  taxRate: z.number().min(0).max(100).nullable().optional(),
  discount: z.number().nonnegative().nullable().optional(),
  locationId: z.string().min(1).optional(),
  lines: z.array(lineSchema).min(1, "Add at least one line").optional(),
});

export const listInvoiceQuerySchema = z.object({
  status: z.enum(["DRAFT", "ISSUED", "PAID", "CANCELLED"]).optional(),
  number: z.coerce.number().int().positive().optional(),
  customerId: z.string().optional(),
  take: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;
export type ListInvoiceQuery = z.infer<typeof listInvoiceQuerySchema>;
