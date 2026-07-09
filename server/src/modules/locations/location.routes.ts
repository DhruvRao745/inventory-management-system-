/**
 * Locations — small module, same shape as the others.
 * (Small enough that routes + logic live in one file; if it grows,
 * we split out a service like the bigger modules.)
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

const createLocationSchema = z.object({
  name: z.string().trim().min(2, "Name is too short"),
  address: z.string().trim().optional(),
});

export const locationsRouter = Router();
locationsRouter.use(requireAuth);

// GET /api/locations — everyone logged in can see the list
locationsRouter.get(
  "/",
  asyncHandler(async (req: AuthRequest, res) => {
    const locations = await prisma.location.findMany({
      where: { companyId: req.user!.companyId },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    });
    res.json(locations);
  })
);

// POST /api/locations — only ADMIN/MANAGER can open a new place
locationsRouter.post(
  "/",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = createLocationSchema.parse(req.body);
    const companyId = req.user!.companyId;

    const duplicate = await prisma.location.findFirst({
      where: { companyId, name: input.name },
    });
    if (duplicate) {
      throw new AppError(409, `Location "${input.name}" already exists`);
    }

    const location = await prisma.location.create({
      data: { ...input, companyId },
    });
    res.status(201).json(location);
  })
);

// PATCH /api/locations/:id — rename / change address (ADMIN/MANAGER)
locationsRouter.patch(
  "/:id",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = createLocationSchema.partial().parse(req.body);
    const companyId = req.user!.companyId;

    const target = await prisma.location.findFirst({
      where: { id: req.params.id, companyId },
    });
    if (!target) throw new AppError(404, "Location not found");

    if (input.name) {
      const duplicate = await prisma.location.findFirst({
        where: { companyId, name: input.name, NOT: { id: target.id } },
      });
      if (duplicate) {
        throw new AppError(409, `Location "${input.name}" already exists`);
      }
    }

    const location = await prisma.location.update({
      where: { id: target.id },
      data: input,
    });
    res.json(location);
  })
);
