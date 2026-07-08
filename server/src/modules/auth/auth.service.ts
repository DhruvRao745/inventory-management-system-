/**
 * The auth "service" — the brain. It knows nothing about HTTP;
 * it just does the real work: create accounts, check passwords,
 * print badges. Routes call these functions.
 *
 * Why separate? So the logic can be tested on its own, and if we
 * ever change how requests arrive, the brain doesn't change.
 */
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { AppError } from "../../middleware/error.js";
import type { RegisterInput, LoginInput } from "./auth.schemas.js";
import type { AuthPayload } from "../../middleware/auth.js";

/** Print a badge: a signed note saying who you are + your company. */
function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "7d" });
}

/** What we send back — note: NEVER the passwordHash. */
function publicUser(user: {
  id: string;
  name: string;
  email: string;
  role: string;
  companyId: string;
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
  };
}

/**
 * New company signs up. Three rows must be born TOGETHER:
 * the Company, its default Location, and the first ADMIN user.
 * We wrap them in a transaction: either all three succeed, or
 * none happen. No half-created companies, ever.
 */
export async function register(input: RegisterInput) {
  const existing = await prisma.user.findFirst({
    where: { email: input.email },
  });
  if (existing) {
    throw new AppError(409, "This email is already registered");
  }

  // Grind the password into powder. 10 = how many times to grind
  // (each round doubles the work an attacker needs).
  const passwordHash = await bcrypt.hash(input.password, 10);

  const result = await prisma.$transaction(async (tx) => {
    const company = await tx.company.create({
      data: { name: input.companyName },
    });

    await tx.location.create({
      data: {
        companyId: company.id,
        name: "Main Location",
        isDefault: true,
      },
    });

    const user = await tx.user.create({
      data: {
        companyId: company.id,
        email: input.email,
        passwordHash,
        name: input.name,
        role: "ADMIN", // the founder runs the place
      },
    });

    return { company, user };
  });

  const token = signToken({
    userId: result.user.id,
    companyId: result.company.id,
    role: "ADMIN",
  });

  return {
    token,
    user: publicUser(result.user),
    company: { id: result.company.id, name: result.company.name },
  };
}

export async function login(input: LoginInput) {
  const user = await prisma.user.findFirst({
    where: { email: input.email, isActive: true },
    include: { company: true },
  });

  // compare() grinds the attempt the same way and checks the powders match
  const passwordOk =
    user && (await bcrypt.compare(input.password, user.passwordHash));

  // ONE vague message for both "no such user" and "wrong password".
  // If we said which one it was, attackers could fish for valid emails.
  if (!user || !passwordOk) {
    throw new AppError(401, "Invalid email or password");
  }

  const token = signToken({
    userId: user.id,
    companyId: user.companyId,
    role: user.role,
  });

  return {
    token,
    user: publicUser(user),
    company: { id: user.company.id, name: user.company.name },
  };
}

/** Look up fresh info about the badge holder (for GET /me). */
export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { company: true },
  });
  if (!user || !user.isActive) {
    throw new AppError(401, "Account not found or deactivated");
  }
  return {
    user: publicUser(user),
    company: { id: user.company.id, name: user.company.name },
  };
}
