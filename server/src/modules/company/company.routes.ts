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

const updateCompanySchema = z.object({
  name: z.string().trim().min(2, "Name is too short").optional(),
  // ISO 4217 currency codes are exactly 3 uppercase letters
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "Use a 3-letter code like INR or USD")
    .optional(),
});

export const companyRouter = Router();
companyRouter.use(requireAuth);

companyRouter.get(
  "/",
  asyncHandler(async (req: AuthRequest, res) => {
    const company = await prisma.company.findUnique({
      where: { id: req.user!.companyId },
      select: { id: true, name: true, currency: true, createdAt: true },
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
      select: { id: true, name: true, currency: true },
    });
    res.json(company);
  })
);
