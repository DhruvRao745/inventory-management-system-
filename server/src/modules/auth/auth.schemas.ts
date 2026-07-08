/**
 * Validation rules for auth requests.
 *
 * Rule of survival: NEVER trust what arrives over the network.
 * Zod checks the shape and quality of req.body before our logic
 * ever touches it. Bad input → automatic 400 with clear messages
 * (see errorHandler).
 */
import { z } from "zod";

export const registerSchema = z.object({
  companyName: z.string().trim().min(2, "Company name is too short"),
  name: z.string().trim().min(2, "Your name is too short"),
  email: z.string().trim().toLowerCase().email("Not a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Not a valid email"),
  password: z.string().min(1, "Password is required"),
});

// TypeScript types derived from the rules — one source of truth
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
