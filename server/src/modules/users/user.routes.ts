/**
 * Users module — managing the team.
 *
 * Reading the list: any logged-in user (you can see your colleagues).
 * Creating/changing users: ADMIN only.
 *
 * The self-protection rule: an admin cannot deactivate or demote
 * THEMSELVES. Sounds silly until the day the only admin clicks the
 * wrong button and the company is locked out of its own system.
 */
import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler, AppError } from "../../middleware/error.js";
import {
  requireAuth,
  requireRole,
  type AuthRequest,
} from "../../middleware/auth.js";

const createUserSchema = z.object({
  name: z.string().trim().min(2, "Name is too short"),
  email: z.string().trim().toLowerCase().email("Not a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.enum(["ADMIN", "MANAGER", "STAFF"]).default("STAFF"),
});

const updateUserSchema = z.object({
  role: z.enum(["ADMIN", "MANAGER", "STAFF"]).optional(),
  isActive: z.boolean().optional(),
});

// Fields safe to send to the browser — passwordHash NEVER leaves
const publicFields = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
} as const;

export const usersRouter = Router();
usersRouter.use(requireAuth);

// GET /api/users — the team list
usersRouter.get(
  "/",
  asyncHandler(async (req: AuthRequest, res) => {
    const users = await prisma.user.findMany({
      where: { companyId: req.user!.companyId },
      select: publicFields,
      orderBy: { createdAt: "asc" },
    });
    res.json(users);
  })
);

// POST /api/users — add a team member (ADMIN only)
usersRouter.post(
  "/",
  requireRole("ADMIN"),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = createUserSchema.parse(req.body);

    // same global-email check as registration — one email, one account
    const existing = await prisma.user.findFirst({
      where: { email: input.email },
    });
    if (existing) throw new AppError(409, "This email is already registered");

    const passwordHash = await bcrypt.hash(input.password, 10);

    const user = await prisma.user.create({
      data: {
        companyId: req.user!.companyId,
        name: input.name,
        email: input.email,
        passwordHash,
        role: input.role,
      },
      select: publicFields,
    });
    res.status(201).json(user);
  })
);

// PATCH /api/users/:id — change role or active status (ADMIN only)
usersRouter.patch(
  "/:id",
  requireRole("ADMIN"),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = updateUserSchema.parse(req.body);
    const companyId = req.user!.companyId;

    // must exist AND be ours — the golden rule, as always
    const target = await prisma.user.findFirst({
      where: { id: req.params.id, companyId },
    });
    if (!target) throw new AppError(404, "User not found");

    // the self-protection rule
    if (target.id === req.user!.userId) {
      if (input.isActive === false)
        throw new AppError(400, "You can't deactivate your own account");
      if (input.role && input.role !== "ADMIN")
        throw new AppError(400, "You can't demote your own account");
    }

    const user = await prisma.user.update({
      where: { id: target.id },
      data: input,
      select: publicFields,
    });
    res.json(user);
  })
);
