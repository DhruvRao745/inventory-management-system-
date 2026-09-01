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
import {
  createSession,
  rotateSession,
  revokeSession,
  revokeAllForUser,
  listSessions,
  SessionError,
  type SessionContext,
} from "../../lib/sessions.js";
import { recordSecurityEvent } from "../../lib/audit.js";

/**
 * Two badges:
 * - access token  = the DAY PASS: shown at every door, expires in 15 min.
 *   If stolen, it's useless within minutes.
 * - refresh token = the RENEWAL CARD: used only at /auth/refresh to print
 *   a fresh day pass. Different secret, lasts 30 days.
 */
function signAccessToken(payload: AuthPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "15m" });
}

/**
 * CHANGED IN P2-5: refresh tokens are no longer JWTs.
 *
 * A JWT is self-validating — anyone holding one can prove it is genuine
 * without asking us. That is exactly wrong for a refresh token, because the
 * whole point is that the SERVER decides whether it is still good. A refresh
 * token is now opaque random bytes recorded in the Session table, so logging
 * out and revoking actually mean something (see lib/sessions.ts).
 *
 * JWT_REFRESH_SECRET is therefore no longer used to sign anything. It stays in
 * the config, still validated at boot, because rotating it is the emergency
 * lever if the session table itself is ever compromised.
 */
async function issueTokenPair(
  payload: AuthPayload,
  ctx: SessionContext = {}
) {
  const { refreshToken, sessionId } = await createSession(
    payload.userId,
    payload.companyId,
    ctx
  );
  return { token: signAccessToken(payload), refreshToken, sessionId };
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

// One shape for the company object every auth response returns, so register,
// login and /me can't drift. Business-detail fields ride along so the invoice
// (which reads company from context) has them without a second request.
function publicCompany(company: {
  id: string;
  name: string;
  currency: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  gstin?: string | null;
  pan?: string | null;
  /**
   * GST state code (P2-3).
   *
   * This shape is what /auth/me and login return, and the client seeds the
   * Settings form from it. A field missing here reads as "not set" on screen
   * however correct the database is — which is exactly how it was lost the
   * first time.
   */
  stateCode?: string | null;
  sealText?: string | null;
  invoiceTerms?: string | null;
}) {
  return {
    id: company.id,
    name: company.name,
    currency: company.currency,
    address: company.address ?? null,
    phone: company.phone ?? null,
    email: company.email ?? null,
    gstin: company.gstin ?? null,
    pan: company.pan ?? null,
    stateCode: company.stateCode ?? null,
    sealText: company.sealText ?? null,
    invoiceTerms: company.invoiceTerms ?? null,
  };
}

/**
 * New company signs up. Three rows must be born TOGETHER:
 * the Company, its default Location, and the first ADMIN user.
 * We wrap them in a transaction: either all three succeed, or
 * none happen. No half-created companies, ever.
 */
export async function register(input: RegisterInput, ctx: SessionContext = {}) {
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

  const tokens = await issueTokenPair(
    {
      userId: result.user.id,
      companyId: result.company.id,
      role: "ADMIN",
    },
    ctx
  );

  return {
    ...tokens,
    user: publicUser(result.user),
    company: publicCompany(result.company),
  };
}

export async function login(input: LoginInput, ctx: SessionContext = {}) {
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
    // Recorded even though the request fails — a burst of these is what an
    // attack looks like from the inside, and it is the single most useful
    // thing in the whole log. `companyId` may be unknown when the email
    // matches nobody, so we only log when we can attribute it to a tenant.
    if (user) {
      await recordSecurityEvent({
        companyId: user.companyId,
        userId: user.id,
        actorEmail: input.email,
        action: "login.failed",
        entity: "user",
        entityId: user.id,
        summary: `Failed sign-in for ${input.email}`,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
    }
    throw new AppError(401, "Invalid email or password");
  }

  const tokens = await issueTokenPair(
    {
      userId: user.id,
      companyId: user.companyId,
      role: user.role,
    },
    ctx
  );

  await recordSecurityEvent({
    companyId: user.companyId,
    userId: user.id,
    actorEmail: user.email,
    action: "login",
    entity: "user",
    entityId: user.id,
    summary: `${user.name} signed in`,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });

  return {
    ...tokens,
    user: publicUser(user),
    company: publicCompany(user.company),
  };
}

/**
 * The renewal counter — rewritten in P2-5.
 *
 * It used to verify a JWT signature and hand back a fresh access token. The
 * signature was the ONLY check, which meant the server had no say in whether
 * the session was still supposed to exist. Now the token is looked up, and:
 *
 *   • an unknown, expired or revoked token is refused
 *   • presenting an already-rotated token revokes the whole family (theft)
 *   • a successful refresh RETIRES the token used and returns a new one
 *
 * The user is still re-read from the database, as before — their role may have
 * changed since the session began, and an access token must never carry a
 * privilege the person no longer holds.
 */
export async function refresh(refreshToken: string, ctx: SessionContext = {}) {
  let rotated;
  try {
    rotated = await rotateSession(refreshToken, ctx);
  } catch (err) {
    if (err instanceof SessionError) throw new AppError(401, err.message);
    throw err;
  }

  const user = await prisma.user.findUnique({
    where: { id: rotated.userId },
  });
  if (!user || !user.isActive) {
    // Deactivated mid-session: end the session rather than leaving a valid
    // token attached to an account that is no longer allowed in.
    await revokeSession(rotated.refreshToken, "account-inactive");
    throw new AppError(401, "Account not found or deactivated");
  }

  return {
    token: signAccessToken({
      userId: user.id,
      companyId: user.companyId,
      role: user.role,
    }),
    // The client MUST store this — the token it sent is now dead.
    refreshToken: rotated.refreshToken,
  };
}

/**
 * Log out — for real this time (P2-5).
 *
 * Previously the client just deleted its copy of the token, which stopped
 * exactly nobody: any other copy kept working for thirty days. Now the session
 * is revoked server-side, so the token is dead everywhere at once.
 *
 * Returns quietly whether or not the token was found. Reporting "no such
 * session" would let an attacker probe which tokens are live, and there is
 * nothing useful a caller could do with the distinction anyway.
 */
export async function logout(refreshToken: string): Promise<void> {
  await revokeSession(refreshToken, "logout");
}

/** Every device this user is currently signed in on. */
export async function getSessions(userId: string, currentSessionId?: string) {
  return listSessions(userId, currentSessionId);
}

/**
 * Sign out every OTHER device, keeping the one making the request.
 *
 * Keeping the caller's own session is what makes this button usable — signing
 * yourself out while pressing "sign out other devices" is a confusing result.
 */
export async function revokeOtherSessions(
  userId: string,
  keepRefreshToken?: string
): Promise<number> {
  let keepId: string | undefined;
  if (keepRefreshToken) {
    const { hashToken } = await import("../../lib/sessions.js");
    const current = await prisma.session.findUnique({
      where: { tokenHash: hashToken(keepRefreshToken) },
      select: { id: true },
    });
    keepId = current?.id;
  }
  return revokeAllForUser(userId, "revoked", keepId);
}

/**
 * Change a password, and sign out everywhere else (P2-5).
 *
 * The other-session revocation is the point, not a side effect. People change
 * a password because they think somebody else has access — leaving that
 * somebody's session alive defeats the entire exercise, and worse, leaves the
 * user believing they have fixed it.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepRefreshToken?: string
): Promise<{ revokedSessions: number }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, "User not found");

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw new AppError(401, "Current password is incorrect");

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await bcrypt.hash(newPassword, 10) },
  });

  let keepId: string | undefined;
  if (keepRefreshToken) {
    const { hashToken } = await import("../../lib/sessions.js");
    const current = await prisma.session.findUnique({
      where: { tokenHash: hashToken(keepRefreshToken) },
      select: { id: true },
    });
    keepId = current?.id;
  }

  const revokedSessions = await revokeAllForUser(
    userId,
    "password-change",
    keepId
  );

  // No before/after — there is nothing here that can safely be written down.
  // The FACT and the TIME are what matter.
  await recordSecurityEvent({
    companyId: user.companyId,
    userId: user.id,
    actorEmail: user.email,
    action: "password.change",
    entity: "user",
    entityId: user.id,
    summary: `Password changed; ${revokedSessions} other session(s) ended`,
  });

  return { revokedSessions };
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
    company: publicCompany(user.company),
  };
}
