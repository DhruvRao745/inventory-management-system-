/**
 * Categories — shop sections. Small module, one file.
 *
 * Why DELETE is allowed here (unlike products): nothing historical
 * points at a category. Products reference it, but "categoryId" is
 * optional — deleting a category just makes its products uncategorized.
 * We handle that by clearing categoryId first, then deleting.
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

const categorySchema = z.object({
  name: z.string().trim().min(2, "Name is too short"),
});

export const categoriesRouter = Router();
categoriesRouter.use(requireAuth);

const canWrite = requireRole("ADMIN", "MANAGER");

// GET /api/categories — list, with product counts (nice for the UI)
categoriesRouter.get(
  "/",
  asyncHandler(async (req: AuthRequest, res) => {
    const categories = await prisma.category.findMany({
      where: { companyId: req.user!.companyId },
      include: { _count: { select: { products: true } } },
      orderBy: { name: "asc" },
    });
    res.json(
      categories.map((c) => ({
        id: c.id,
        name: c.name,
        productCount: c._count.products,
      }))
    );
  })
);

// POST /api/categories
categoriesRouter.post(
  "/",
  canWrite,
  asyncHandler(async (req: AuthRequest, res) => {
    const input = categorySchema.parse(req.body);
    const companyId = req.user!.companyId;

    const duplicate = await prisma.category.findFirst({
      where: { companyId, name: input.name },
    });
    if (duplicate)
      throw new AppError(409, `Category "${input.name}" already exists`);

    const category = await prisma.category.create({
      data: { ...input, companyId },
    });
    res.status(201).json(category);
  })
);

// PATCH /api/categories/:id — rename
categoriesRouter.patch(
  "/:id",
  canWrite,
  asyncHandler(async (req: AuthRequest, res) => {
    const input = categorySchema.parse(req.body);
    const companyId = req.user!.companyId;

    const target = await prisma.category.findFirst({
      where: { id: req.params.id, companyId },
    });
    if (!target) throw new AppError(404, "Category not found");

    const duplicate = await prisma.category.findFirst({
      where: { companyId, name: input.name, NOT: { id: target.id } },
    });
    if (duplicate)
      throw new AppError(409, `Category "${input.name}" already exists`);

    const category = await prisma.category.update({
      where: { id: target.id },
      data: input,
    });
    res.json(category);
  })
);

// DELETE /api/categories/:id — products become uncategorized
categoriesRouter.delete(
  "/:id",
  canWrite,
  asyncHandler(async (req: AuthRequest, res) => {
    const companyId = req.user!.companyId;

    const target = await prisma.category.findFirst({
      where: { id: req.params.id, companyId },
    });
    if (!target) throw new AppError(404, "Category not found");

    // Two steps that must both happen → transaction, as always
    await prisma.$transaction([
      prisma.product.updateMany({
        where: { categoryId: target.id, companyId },
        data: { categoryId: null },
      }),
      prisma.category.delete({ where: { id: target.id } }),
    ]);

    res.status(204).send();
  })
);
