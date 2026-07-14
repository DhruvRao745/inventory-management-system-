/**
 * The auth routes — the front desk itself. Thin on purpose:
 * check the paperwork (schema), call the brain (service), send the answer.
 */
import { Router } from "express";
import { z } from "zod";
import { registerSchema, loginSchema } from "./auth.schemas.js";
import * as authService from "./auth.service.js";
import { asyncHandler, AppError } from "../../middleware/error.js";
import { requireAuth, type AuthRequest } from "../../middleware/auth.js";
import { loginLimiter } from "../../middleware/rateLimit.js";

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
// loginLimiter: 10 failed tries per IP+email, then 15 min cooldown
authRouter.post(
  "/login",
  loginLimiter,
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const result = await authService.login(input);
    res.json(result);
  })
);

// POST /api/auth/refresh — trade a renewal card for a fresh day pass
authRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const { refreshToken } = z
      .object({ refreshToken: z.string().min(1) })
      .parse(req.body);
    const result = await authService.refresh(refreshToken);
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
