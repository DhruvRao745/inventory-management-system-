/**
 * Environment validation.
 *
 * WHY: if the server starts with a missing/typo'd env variable, you want it
 * to crash IMMEDIATELY with a clear message — not fail mysteriously at 2am
 * when the first request hits the database. Zod validates process.env once,
 * at startup, and gives us a fully typed `env` object everywhere else.
 */
import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(5000),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  JWT_REFRESH_SECRET: z.string().min(1, "JWT_REFRESH_SECRET is required"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
