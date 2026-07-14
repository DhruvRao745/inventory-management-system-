/**
 * Two bouncers, two different jobs:
 *
 * authIpLimiter (loose) — 100 req / 15 min per IP address.
 *   Catches bots hammering from one machine, even across many emails.
 *   Loose enough that a whole office behind one router never feels it.
 *
 * loginLimiter (strict) — 10 FAILED attempts / 15 min per IP+email pair.
 *   Wrong passwords on rao@ block only rao@ from that network —
 *   colleagues on the same office IP are unaffected.
 *   skipSuccessfulRequests: correct logins don't count toward the limit,
 *   so normal daily use never trips it.
 */
import rateLimit from "express-rate-limit";
import type { Request } from "express";

const tooMany = {
  handler: (_req: Request, res: import("express").Response) => {
    res
      .status(429)
      .json({ error: "Too many attempts — please try again in 15 minutes" });
  },
  standardHeaders: true as const,
  legacyHeaders: false as const,
};

export const authIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  ...tooMany,
});

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true, // only FAILED logins count
  keyGenerator: (req: Request) => {
    // bucket = visitor IP + the email they're attacking
    const email =
      typeof req.body?.email === "string" ? req.body.email.toLowerCase() : "";
    return `${req.ip ?? "unknown"}|${email}`;
  },
  ...tooMany,
});
