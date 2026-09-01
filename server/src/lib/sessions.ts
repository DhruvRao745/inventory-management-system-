/**
 * Server-side sessions (P2-5, PRD §15).
 *
 * WHAT WAS BROKEN
 *
 * A refresh token was a signed JWT and nothing else. The server verified the
 * signature and the expiry date, and that was the entire check. It kept no
 * record that the token existed, so it had no way to later say "not any more".
 *
 * Logging out cleared localStorage. Anyone holding a copy of the token — taken
 * from a shared machine, a browser backup, a proxy log — could keep minting
 * fresh access tokens for thirty days, and no action available to the user or
 * an admin would stop them. The only remedy was rotating JWT_REFRESH_SECRET,
 * which signs out every user on every device at once.
 *
 * WHAT THIS FIXES, AND WHAT IT DOESN'T
 *
 * Refresh tokens are now recorded, revocable, and rotated on every use. Access
 * tokens are still stateless JWTs and are NOT checked against the database —
 * that is deliberate. Checking one on every request would put a database read
 * in front of every API call in the system. Instead they live 15 minutes, so a
 * revoked session dies within that window. The trade is explicit: a 15-minute
 * tail of access, in exchange for not making the database a single point of
 * failure for every request.
 *
 * WHY SHA-256 AND NOT BCRYPT
 *
 * bcrypt is deliberately slow to make guessing a human-chosen password
 * expensive. A refresh token is 256 bits of server-generated randomness — it
 * cannot be guessed, so the slowness buys nothing and costs a lot, because
 * this runs on every token refresh. SHA-256 is the right tool: fast, and
 * irreversible, which is all that's needed.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";

/** How long a refresh token — and so a session — may live. */
export const SESSION_TTL_DAYS = 30;

/**
 * Mint a refresh token.
 *
 * Opaque random bytes, NOT a JWT. A JWT carries readable claims and is
 * self-validating, which is exactly wrong here: the whole point is that the
 * server decides whether this token is still good, by looking it up. Making it
 * self-validating would reintroduce the problem being fixed.
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("hex");
}

/** SHA-256, hex. The only form of the token that ever touches the database. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function expiryFromNow(): Date {
  return new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
}

/** Trim a User-Agent to something storable and readable. */
function tidyUserAgent(ua: string | undefined): string | null {
  if (!ua) return null;
  return ua.slice(0, 200);
}

export type SessionContext = {
  userAgent?: string;
  ipAddress?: string;
};

/**
 * Start a new session — one login, one device.
 *
 * A fresh `familyId` is generated here. Every token that later descends from
 * this login by rotation shares it, which is what makes reuse detection able
 * to kill the right set of sessions and no others.
 */
export async function createSession(
  userId: string,
  companyId: string,
  ctx: SessionContext = {}
): Promise<{ refreshToken: string; sessionId: string }> {
  const refreshToken = generateRefreshToken();

  const session = await prisma.session.create({
    data: {
      userId,
      companyId,
      tokenHash: hashToken(refreshToken),
      familyId: randomUUID(),
      userAgent: tidyUserAgent(ctx.userAgent),
      ipAddress: ctx.ipAddress ?? null,
      expiresAt: expiryFromNow(),
    },
  });

  return { refreshToken, sessionId: session.id };
}

export class SessionError extends Error {
  constructor(
    message: string,
    public reason: "unknown" | "expired" | "revoked" | "reuse"
  ) {
    super(message);
  }
}

/**
 * Exchange a refresh token for a new one — the rotation step.
 *
 * REUSE DETECTION, WHICH IS THE POINT OF THE WHOLE DESIGN
 *
 * Each refresh retires the token presented and issues a successor. So a given
 * token should be used exactly once, ever. If a token that has ALREADY been
 * rotated away turns up again, something is wrong: either it was stolen and
 * replayed, or a legitimate client never received its successor and retried.
 *
 * The two are indistinguishable from here — and that is precisely why the
 * response is to revoke the entire family. If it was theft, the thief and the
 * victim are both cut off immediately, which is what you want. If it was a
 * dropped response, the user logs in again, which is a small annoyance.
 *
 * Choosing the annoyance over the risk is the whole trade, made deliberately:
 * the alternative is an attacker with a working token and nothing to reveal
 * their presence.
 */
export async function rotateSession(
  refreshToken: string,
  ctx: SessionContext = {}
): Promise<{
  refreshToken: string;
  userId: string;
  companyId: string;
  sessionId: string;
}> {
  const tokenHash = hashToken(refreshToken);

  const session = await prisma.session.findUnique({ where: { tokenHash } });
  if (!session) {
    throw new SessionError("Session not found — please log in again", "unknown");
  }

  if (session.revokedAt) {
    // A retired token, presented again. Burn the whole family.
    await revokeFamily(session.familyId, "reuse-detected");
    throw new SessionError(
      "This session was ended for security reasons — please log in again",
      "reuse"
    );
  }

  if (session.expiresAt <= new Date()) {
    throw new SessionError("Session expired — please log in again", "expired");
  }

  const nextToken = generateRefreshToken();

  // Retire the old and mint the successor TOGETHER. If these were separate
  // writes and the second failed, the user would be left holding a token that
  // has been retired with no successor — locked out with nothing to show why.
  const [, next] = await prisma.$transaction([
    prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), revokedReason: "rotated" },
    }),
    prisma.session.create({
      data: {
        userId: session.userId,
        companyId: session.companyId,
        tokenHash: hashToken(nextToken),
        familyId: session.familyId, // same lineage
        userAgent: tidyUserAgent(ctx.userAgent) ?? session.userAgent,
        ipAddress: ctx.ipAddress ?? session.ipAddress,
        expiresAt: session.expiresAt, // rotation does NOT extend the session
        lastUsedAt: new Date(),
      },
    }),
  ]);

  return {
    refreshToken: nextToken,
    userId: session.userId,
    companyId: session.companyId,
    sessionId: next.id,
  };
}

/** End one session — the honest version of logout. */
export async function revokeSession(
  refreshToken: string,
  reason = "logout"
): Promise<boolean> {
  const { count } = await prisma.session.updateMany({
    where: { tokenHash: hashToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return count > 0;
}

/** End a session by id — for the "sign out that device" button. */
export async function revokeSessionById(
  userId: string,
  sessionId: string,
  reason = "revoked"
): Promise<boolean> {
  // Scoped to the user, so nobody can end a session belonging to someone else
  // by guessing an id.
  const { count } = await prisma.session.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return count > 0;
}

/** Kill an entire lineage — used by reuse detection. */
export async function revokeFamily(
  familyId: string,
  reason: string
): Promise<number> {
  const { count } = await prisma.session.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return count;
}

/**
 * Sign out everywhere.
 *
 * `exceptSessionId` keeps the caller's own session alive, which is what makes
 * this usable: "sign out all other devices" should not sign out the device
 * being used to press the button.
 */
export async function revokeAllForUser(
  userId: string,
  reason = "revoked",
  exceptSessionId?: string
): Promise<number> {
  const { count } = await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return count;
}

/** The device list. Live sessions only — a graveyard helps nobody. */
export async function listSessions(userId: string, currentSessionId?: string) {
  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: "desc" },
    select: {
      id: true,
      userAgent: true,
      ipAddress: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
    },
  });

  return sessions.map((s) => ({
    ...s,
    // So the UI can label one "this device" — otherwise the user cannot tell
    // which row is safe to end.
    current: s.id === currentSessionId,
  }));
}

/**
 * Delete sessions that expired a while ago.
 *
 * Housekeeping only: expired sessions are already rejected on use, so this
 * changes no behaviour. It keeps the table from growing without bound —
 * rotation writes a new row on every refresh, so an active user generates a
 * row every fifteen minutes.
 */
export async function purgeExpiredSessions(olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const { count } = await prisma.session.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return count;
}
