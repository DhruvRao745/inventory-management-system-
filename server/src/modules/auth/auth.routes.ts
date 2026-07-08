/**
 * The auth routes — the front desk itself. Thin on purpose:
 * check the paperwork (schema), call the brain (service), send the answer.
 */
import { Router } from "express";
import { registerSchema, loginSchema } from "./auth.schemas.js";
import * as authService from "./auth.service.js";
import { asyncHandler, AppError } from "../../middleware/error.js";
import { requireAuth, type AuthRequest } from "../../middleware/auth.js";

export const authRouter = Router();

// POST /api/auth/register — new company + first admin
authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body); // throws 400 if bad
    const result = await authService.register(input);
    res.status(201).json(result); // 201 = "created"
  })
);

// POST /api/auth/login — returns the badge (token)
authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const result = await authService.login(input);
    res.json(result);
  })
);

// GET /api/auth/me — "who am I?" (requires a valid badge)
authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.user) throw new AppError(401, "Not logged in");
    const result = await authService.getMe(req.user.userId);
    res.json(result);
  })
);
