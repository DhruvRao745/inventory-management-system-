/**
 * Company settings — the company editing itself. ADMIN only for writes.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/error.js";
import {
  requireAuth,
  requireRole,
  type AuthRequest,
} from "../../middleware/auth.js";

// Business details are all optional. An empty string clears the field —
// we normalise "" → null so a blank line never prints on the invoice.
const blankToNull = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "" ? null : v));

const updateCompanySchema = z.object({
  name: z.string().trim().min(2, "Name is too short").optional(),
  // ISO 4217 currency codes are exactly 3 uppercase letters
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "Use a 3-letter code like INR or USD")
    .optional(),
  address: blankToNull(500),
  phone: blankToNull(40),
  email: blankToNull(120),
  gstin: blankToNull(20),
  pan: blankToNull(20),
  sealText: blankToNull(60),
  invoiceTerms: blankToNull(2000),
});

// One field list, so GET and PATCH can't drift out of sync.
const companySelect = {
  id: true,
  name: true,
  currency: true,
  address: true,
  phone: true,
  email: true,
  gstin: true,
  pan: true,
  sealText: true,
  invoiceTerms: true,
} as const;

export const companyRouter = Router();
companyRouter.use(requireAuth);

companyRouter.get(
  "/",
  asyncHandler(async (req: AuthRequest, res) => {
    const company = await prisma.company.findUnique({
      where: { id: req.user!.companyId },
      select: { ...companySelect, createdAt: true },
    });
    res.json(company);
  })
);

companyRouter.patch(
  "/",
  requireRole("ADMIN"),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = updateCompanySchema.parse(req.body);
    const company = await prisma.company.update({
      where: { id: req.user!.companyId },
      data: input,
      select: companySelect,
    });
    res.json(company);
  })
);
