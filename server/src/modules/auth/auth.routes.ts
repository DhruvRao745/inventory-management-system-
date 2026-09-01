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
import { hashToken } from "../../lib/sessions.js";
import { prisma } from "../../lib/prisma.js";

/**
 * What we can learn about the device making the request (P2-5).
 *
 * Both values are attacker-controlled and shown to the user for recognition
 * only — "was that me on Chrome, Mumbai?" They are never used for any security
 * decision, because a User-Agent is a string anyone can set to anything.
 */
function sessionContext(req: { headers: Record<string, unknown>; ip?: string }) {
  return {
    userAgent:
      typeof req.headers["user-agent"] === "string"
        ? (req.headers["user-agent"] as string)
        : undefined,
    ipAddress: req.ip,
  };
}

const refreshBodySchema = z.object({ refreshToken: z.string().min(1) });

export const authRouter = Router();

// POST /api/auth/register — new company + first admin
authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body); // throws 400 if bad
    const result = await authService.register(input, sessionContext(req));
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
    const result = await authService.login(input, sessionContext(req));
    res.json(result);
  })
);

// POST /api/auth/refresh — trade a renewal card for a fresh day pass
authRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const { refreshToken } = refreshBodySchema.parse(req.body);
    // The response now carries a NEW refreshToken — the one just sent is dead.
    // Clients must store it or the next refresh will look like a replay.
    const result = await authService.refresh(refreshToken, sessionContext(req));
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

/**
 * POST /api/auth/logout — end THIS session, server-side (P2-5).
 *
 * Deliberately not behind requireAuth. Logging out with an expired access
 * token must still work: otherwise the one moment a user most wants to end a
 * session — coming back to a machine they left signed in — is the moment the
 * system refuses. The refresh token in the body is the credential here.
 *
 * Always 204, whether or not the token matched. Reporting "no such session"
 * would let someone probe which tokens are live.
 */
authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const { refreshToken } = refreshBodySchema.parse(req.body);
    await authService.logout(refreshToken);
    res.status(204).end();
  })
);

/**
 * GET /api/auth/sessions — every device currently signed in.
 *
 * The caller may pass its own refresh token so its row can be marked
 * `current: true`. Without that the list is a set of near-identical rows and
 * the user cannot tell which one is safe to end.
 */
authRouter.get(
  "/sessions",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const q = z.object({ refreshToken: z.string().optional() }).parse(req.query);

    let currentId: string | undefined;
    if (q.refreshToken) {
      const current = await prisma.session.findUnique({
        where: { tokenHash: hashToken(q.refreshToken) },
        select: { id: true, userId: true },
      });
      // Only honour it if the session really belongs to the caller — otherwise
      // a stray token could mislabel someone else's row as "this device".
      if (current?.userId === req.user!.userId) currentId = current.id;
    }

    res.json(await authService.getSessions(req.user!.userId, currentId));
  })
);

/** DELETE /api/auth/sessions/:id — sign out one specific device. */
authRouter.delete(
  "/sessions/:id",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const { revokeSessionById } = await import("../../lib/sessions.js");
    // Scoped to the caller inside revokeSessionById, so guessing another
    // user's session id achieves nothing.
    const ended = await revokeSessionById(req.user!.userId, req.params.id);
    if (!ended) throw new AppError(404, "Session not found");
    res.status(204).end();
  })
);

/** POST /api/auth/sessions/revoke-others — sign out everywhere but here. */
authRouter.post(
  "/sessions/revoke-others",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const { refreshToken } = z
      .object({ refreshToken: z.string().optional() })
      .parse(req.body ?? {});
    const revoked = await authService.revokeOtherSessions(
      req.user!.userId,
      refreshToken
    );
    res.json({ revoked });
  })
);

/**
 * POST /api/auth/change-password
 *
 * Signs out every other device as a matter of course — see the note on
 * authService.changePassword for why that is the point rather than a side
 * effect.
 */
authRouter.post(
  "/change-password",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const input = z
      .object({
        currentPassword: z.string().min(1),
        newPassword: z
          .string()
          .min(8, "Use at least 8 characters")
          .max(200),
        refreshToken: z.string().optional(),
      })
      .parse(req.body);

    const result = await authService.changePassword(
      req.user!.userId,
      input.currentPassword,
      input.newPassword,
      input.refreshToken
    );
    res.json(result);
  })
);
