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
  // Where the React dev server runs (for CORS). Irrelevant in production,
  // where Express serves the client itself — same origin, no CORS needed.
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

/**
 * Refuse to boot in production with a placeholder secret.
 *
 * This exists because it already happened: the live deployment ran with
 * JWT_SECRET="change-me-in-production" — the literal example value that is
 * published in .env.example for anyone to read. Those two strings sign every
 * login token, so knowing them means being able to forge a session as any
 * user in any company.
 *
 * A comment saying "generate long random strings for production!" did not
 * prevent it. A crash on startup does. Failing loudly at deploy time is far
 * cheaper than a silent authentication bypass.
 *
 * Development and tests are deliberately exempt — short fixed secrets there
 * are convenient and harmless.
 */
const PLACEHOLDER_SECRETS = [
  "change-me-in-production",
  "change-me-too-in-production",
  "local-test-only-secret",
  "local-test-only-refresh",
  "test-only-secret",
  "test-only-refresh",
  "secret",
  "changeme",
];
const MIN_SECRET_LENGTH = 32;

if (parsed.data.NODE_ENV === "production") {
  const problems: string[] = [];

  for (const name of ["JWT_SECRET", "JWT_REFRESH_SECRET"] as const) {
    const value = parsed.data[name];
    if (PLACEHOLDER_SECRETS.includes(value.toLowerCase())) {
      problems.push(`${name} is a known placeholder value`);
    } else if (value.length < MIN_SECRET_LENGTH) {
      problems.push(
        `${name} is only ${value.length} characters (minimum ${MIN_SECRET_LENGTH})`
      );
    }
  }

  // Reusing one secret for both means a refresh token is also a valid access
  // token, collapsing the short-lived/long-lived distinction entirely.
  if (parsed.data.JWT_SECRET === parsed.data.JWT_REFRESH_SECRET) {
    problems.push("JWT_SECRET and JWT_REFRESH_SECRET must be different");
  }

  if (problems.length > 0) {
    console.error("❌ Refusing to start in production with unsafe secrets:");
    for (const p of problems) console.error(`   • ${p}`);
    console.error(
      "\n   Generate each one with:\n" +
        '   node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
    process.exit(1);
  }
}

export const env = parsed.data;
