/**
 * Customers — who we sell to. Master data, same shape as suppliers.
 *
 * GET   /api/customers        list
 * GET   /api/customers/:id    one
 * POST  /api/customers        create (ADMIN/MANAGER)
 * PATCH /api/customers/:id    edit / (de)activate (ADMIN/MANAGER)
 */
import { Router } from "express";
import { z } from "zod";
import { isValidStateCode } from "../../lib/gst.js";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler, AppError } from "../../middleware/error.js";
import {
  requireAuth,
  requireRole,
  type AuthRequest,
} from "../../middleware/auth.js";

const createSchema = z.object({
  name: z.string().trim().min(2, "Name is too short"),
  email: z.string().trim().email("Invalid email").optional().or(z.literal("")),
  phone: z.string().trim().optional(),
  address: z.string().trim().optional(),
  // Buyer's GST details (P2-3). stateCode is the place of supply for goods —
  // it is what makes an invoice to this customer intra- or inter-state.
  gstin: z.string().trim().max(20).optional(),
  stateCode: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || isValidStateCode(v), {
      message: "Not a valid GST state code",
    }),
  notes: z.string().trim().optional(),
});
const updateSchema = createSchema.partial().extend({
  isActive: z.boolean().optional(),
});

function normalizeEmail<T extends { email?: string }>(input: T) {
  if (input.email === "") return { ...input, email: null };
  return input;
}

export const customersRouter = Router();
customersRouter.use(requireAuth);

customersRouter.get(
  "/",
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(
      await prisma.customer.findMany({
        where: { companyId: req.user!.companyId },
        orderBy: [{ isActive: "desc" }, { name: "asc" }],
      })
    );
  })
);

customersRouter.get(
  "/:id",
  asyncHandler(async (req: AuthRequest, res) => {
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, companyId: req.user!.companyId },
    });
    if (!customer) throw new AppError(404, "Customer not found");
    res.json(customer);
  })
);

customersRouter.post(
  "/",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = createSchema.parse(req.body);
    const companyId = req.user!.companyId;
    const dup = await prisma.customer.findFirst({
      where: { companyId, name: input.name },
    });
    if (dup) throw new AppError(409, `Customer "${input.name}" already exists`);
    const customer = await prisma.customer.create({
      data: { ...normalizeEmail(input), companyId },
    });
    res.status(201).json(customer);
  })
);

customersRouter.patch(
  "/:id",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = updateSchema.parse(req.body);
    const companyId = req.user!.companyId;
    const target = await prisma.customer.findFirst({
      where: { id: req.params.id, companyId },
    });
    if (!target) throw new AppError(404, "Customer not found");
    if (input.name) {
      const dup = await prisma.customer.findFirst({
        where: { companyId, name: input.name, NOT: { id: target.id } },
      });
      if (dup) throw new AppError(409, `Customer "${input.name}" already exists`);
    }
    const customer = await prisma.customer.update({
      where: { id: target.id },
      data: normalizeEmail(input),
    });
    res.json(customer);
  })
);
