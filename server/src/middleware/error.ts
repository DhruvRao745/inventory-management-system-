/**
 * Error handling — the "polite complaints desk" of our API.
 *
 * Three pieces:
 * 1. AppError    — an error WE throw on purpose, with a status code.
 *                  Example: throw new AppError(409, "Email already in use")
 * 2. asyncHandler— a safety net. Express (v4) doesn't catch errors from
 *                  async functions on its own; this wrapper catches them
 *                  and passes them to the error handler below.
 * 3. errorHandler— the LAST middleware in the chain. Whatever goes wrong
 *                  anywhere ends up here, and leaves as clean JSON.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { ZodError } from "zod";
import { env } from "../config/env.js";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
  }
}

export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  // Bad input caught by Zod validation → 400 with field-by-field details
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Validation failed",
      details: err.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      })),
    });
  }

  // An error we threw on purpose → use its status and message
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  // Anything unexpected → log the full details for US,
  // but tell the user only "something broke" (never leak internals)
  console.error("💥 Unexpected error:", err);
  return res.status(500).json({
    error:
      env.NODE_ENV === "development" && err instanceof Error
        ? err.message
        : "Internal server error",
  });
}
