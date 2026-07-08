/**
 * The badge checker.
 *
 * Protected routes put this guard in front of the door. It:
 * 1. Looks for the badge: the "Authorization: Bearer <token>" header
 * 2. Verifies the badge is real (signed by US) and not expired
 * 3. Writes the badge's info onto req.user, so every route after
 *    this knows WHO is asking and WHICH COMPANY they belong to
 *
 * If anything is off → 401 Unauthorized, request never reaches the route.
 */
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { AppError } from "./error.js";

// What we stamp inside every badge
export interface AuthPayload {
  userId: string;
  companyId: string;
  role: "ADMIN" | "MANAGER" | "STAFF";
}

// Same as Express's Request, plus our .user field
export interface AuthRequest extends Request {
  user?: AuthPayload;
}

export function requireAuth(
  req: AuthRequest,
  _res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    throw new AppError(401, "Not logged in — token missing");
  }

  const token = header.slice("Bearer ".length);

  try {
    // verify() checks the signature AND the expiry date
    req.user = jwt.verify(token, env.JWT_SECRET) as AuthPayload;
  } catch {
    throw new AppError(401, "Session invalid or expired — please log in again");
  }

  next(); // all good — let the request through the door
}

/**
 * A second, stricter guard for doors that need a certain rank.
 * Usage:  router.post("/", requireAuth, requireRole("ADMIN", "MANAGER"), ...)
 *
 * Note the difference in answers:
 *   401 = "I don't know who you are" (no/bad badge)
 *   403 = "I know exactly who you are — and you may not do this"
 */
export function requireRole(...allowed: AuthPayload["role"][]) {
  return (req: AuthRequest, _res: Response, next: NextFunction) => {
    if (!req.user) {
      throw new AppError(401, "Not logged in — token missing");
    }
    if (!allowed.includes(req.user.role)) {
      throw new AppError(403, "Your role doesn't allow this action");
    }
    next();
  };
}
