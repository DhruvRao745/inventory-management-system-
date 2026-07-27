/**
 * Suppliers — vendors we buy stock from. Master data (Phase 1 of the
 * Suppliers & Purchase Orders feature). Same shape as the locations
 * module: small enough that routes + logic live in one file.
 *
 * GET   /api/suppliers        list (everyone logged in)
 * POST  /api/suppliers        create (ADMIN/MANAGER)
 * PATCH /api/suppliers/:id    edit fields OR toggle isActive (ADMIN/MANAGER)
 *
 * We deactivate rather than delete — a supplier may be referenced by past
 * purchase orders, so its history must survive.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler, AppError } from "../../middleware/error.js";
import {
  requireAuth,
  requireRole,
  type AuthRequest,
} from "../../middleware/auth.js";

const createSupplierSchema = z.object({
  name: z.string().trim().min(2, "Name is too short"),
  email: z.string().trim().email("Invalid email").optional().or(z.literal("")),
  phone: z.string().trim().optional(),
  address: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});

// Edits may also flip isActive (deactivate / reactivate).
const updateSupplierSchema = createSupplierSchema.partial().extend({
  isActive: z.boolean().optional(),
});

// Empty-string email means "clear it" → store null, not "".
function normalizeEmail<T extends { email?: string }>(input: T) {
  if (input.email === "") return { ...input, email: null };
  return input;
}

export const suppliersRouter = Router();
suppliersRouter.use(requireAuth);

// GET /api/suppliers — active first, then alphabetical
suppliersRouter.get(
  "/",
  asyncHandler(async (req: AuthRequest, res) => {
    const suppliers = await prisma.supplier.findMany({
      where: { companyId: req.user!.companyId },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    });
    res.json(suppliers);
  })
);

// GET /api/suppliers/:id — one supplier (tenant-scoped)
suppliersRouter.get(
  "/:id",
  asyncHandler(async (req: AuthRequest, res) => {
    const supplier = await prisma.supplier.findFirst({
      where: { id: req.params.id, companyId: req.user!.companyId },
    });
    if (!supplier) throw new AppError(404, "Supplier not found");
    res.json(supplier);
  })
);

// POST /api/suppliers — ADMIN/MANAGER only
suppliersRouter.post(
  "/",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = createSupplierSchema.parse(req.body);
    const companyId = req.user!.companyId;

    const duplicate = await prisma.supplier.findFirst({
      where: { companyId, name: input.name },
    });
    if (duplicate) {
      throw new AppError(409, `Supplier "${input.name}" already exists`);
    }

    const supplier = await prisma.supplier.create({
      data: { ...normalizeEmail(input), companyId },
    });
    res.status(201).json(supplier);
  })
);

// PATCH /api/suppliers/:id — edit or (de)activate (ADMIN/MANAGER)
suppliersRouter.patch(
  "/:id",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = updateSupplierSchema.parse(req.body);
    const companyId = req.user!.companyId;

    const target = await prisma.supplier.findFirst({
      where: { id: req.params.id, companyId },
    });
    if (!target) throw new AppError(404, "Supplier not found");

    if (input.name) {
      const duplicate = await prisma.supplier.findFirst({
        where: { companyId, name: input.name, NOT: { id: target.id } },
      });
      if (duplicate) {
        throw new AppError(409, `Supplier "${input.name}" already exists`);
      }
    }

    const supplier = await prisma.supplier.update({
      where: { id: target.id },
      data: normalizeEmail(input),
    });
    res.json(supplier);
  })
);
