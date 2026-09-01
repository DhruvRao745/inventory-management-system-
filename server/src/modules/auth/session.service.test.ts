/**
 * Session management (P2-5, PRD §15).
 *
 * WHAT WAS BROKEN, IN ONE SENTENCE: logging out did nothing.
 *
 * A refresh token was a signed JWT and the signature was the only check. The
 * server kept no record that the token existed, so it had no way to later say
 * "not any more". Logout cleared localStorage; any copy of the token taken
 * beforehand — from a shared machine, a proxy log, a browser backup — kept
 * minting fresh access tokens for thirty days, and nothing a user or admin
 * could do would stop it.
 *
 * These tests exist to make sure that stays fixed.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { prisma } from "../../lib/prisma.js";
import { app } from "../../app.js";
import { hashToken, purgeExpiredSessions } from "../../lib/sessions.js";
import { resetDb } from "../../test/helpers.js";

const post = (path: string) => request(app).post(path);

/** Register a company and return its first token pair. */
async function signUp(email = "founder@test.com") {
  const res = await post("/api/auth/register")
    .send({
      companyName: "Test Co",
      name: "Founder",
      email,
      password: "correct horse battery",
    })
    .expect(201);
  return res.body as {
    token: string;
    refreshToken: string;
    user: { id: string };
  };
}

async function signIn(email = "founder@test.com") {
  const res = await post("/api/auth/login")
    .send({ email, password: "correct horse battery" })
    .expect(200);
  return res.body as { token: string; refreshToken: string };
}

describe("sessions — a refresh token is recorded, not just signed", () => {
  beforeEach(resetDb);

  it("logging in creates a session row", async () => {
    const { refreshToken, user } = await signUp();

    const session = await prisma.session.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    expect(session).not.toBeNull();
    expect(session!.userId).toBe(user.id);
    expect(session!.revokedAt).toBeNull();
  });

  it("stores only a HASH — never the token itself", async () => {
    // If this table leaks, the rows must be useless to whoever took them.
    // Storing raw tokens would make a database dump a set of 30-day master
    // keys to every account in the system.
    const { refreshToken } = await signUp();

    const all = await prisma.session.findMany();
    const serialised = JSON.stringify(all);
    expect(serialised).not.toContain(refreshToken);
    expect(all[0]!.tokenHash).toBe(hashToken(refreshToken));
  });

  it("refresh tokens are opaque, not JWTs", async () => {
    // A JWT is self-validating — anyone holding one can prove it genuine
    // without asking us, which is exactly wrong when the server needs the
    // final say on whether a session still exists.
    const { refreshToken } = await signUp();
    expect(refreshToken.split(".")).toHaveLength(1); // no header.payload.sig
  });

  it("two logins are two separate sessions", async () => {
    await signUp();
    await signIn();

    const live = await prisma.session.count({ where: { revokedAt: null } });
    expect(live).toBe(2);
  });
});

describe("sessions — logout actually ends the session", () => {
  beforeEach(resetDb);

  it("a logged-out refresh token stops working", async () => {
    // THE test. Before P2-5 this token kept working for thirty days.
    const { refreshToken } = await signUp();

    await post("/api/auth/logout").send({ refreshToken }).expect(204);
    await post("/api/auth/refresh").send({ refreshToken }).expect(401);
  });

  it("logout works without a valid access token", async () => {
    // The moment someone most wants to end a session — returning to a machine
    // they left signed in — is exactly when their access token has expired.
    // Requiring one would refuse them at that moment.
    const { refreshToken } = await signUp();
    await post("/api/auth/logout").send({ refreshToken }).expect(204);
  });

  it("logging out one device leaves the others alone", async () => {
    const first = await signUp();
    const second = await signIn();

    await post("/api/auth/logout")
      .send({ refreshToken: first.refreshToken })
      .expect(204);

    await post("/api/auth/refresh")
      .send({ refreshToken: second.refreshToken })
      .expect(200);
  });

  it("logging out an unknown token still returns 204", async () => {
    // Reporting "no such session" would let someone probe which tokens are live.
    await signUp();
    await post("/api/auth/logout")
      .send({ refreshToken: "not-a-real-token" })
      .expect(204);
  });
});

describe("sessions — rotation and reuse detection", () => {
  beforeEach(resetDb);

  it("refreshing returns a NEW refresh token", async () => {
    const { refreshToken } = await signUp();

    const res = await post("/api/auth/refresh")
      .send({ refreshToken })
      .expect(200);

    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.refreshToken).not.toBe(refreshToken);
  });

  it("the old token is dead as soon as it has been used once", async () => {
    const { refreshToken } = await signUp();
    await post("/api/auth/refresh").send({ refreshToken }).expect(200);

    // Second use of the SAME token — this is the replay.
    await post("/api/auth/refresh").send({ refreshToken }).expect(401);
  });

  it("replaying a used token kills the whole family", async () => {
    // The heart of the design. A retired token turning up again means either
    // theft-and-replay or a client that lost its successor. The two are
    // indistinguishable from the server, so the safe response is to end the
    // lineage: if it was theft, the thief AND the victim are cut off at once.
    const { refreshToken } = await signUp();

    const rotated = await post("/api/auth/refresh")
      .send({ refreshToken })
      .expect(200);
    const good = rotated.body.refreshToken;

    // The attacker replays the stolen original.
    await post("/api/auth/refresh").send({ refreshToken }).expect(401);

    // ...and the legitimate successor is now dead too. That is intended.
    await post("/api/auth/refresh").send({ refreshToken: good }).expect(401);
  });

  it("only the affected family is revoked, not other devices", async () => {
    // A theft on one device must not sign the user out everywhere — that
    // would make reuse detection too disruptive to keep switched on.
    const first = await signUp();
    const second = await signIn();

    await post("/api/auth/refresh")
      .send({ refreshToken: first.refreshToken })
      .expect(200);
    await post("/api/auth/refresh")
      .send({ refreshToken: first.refreshToken })
      .expect(401); // reuse — family one dies

    await post("/api/auth/refresh")
      .send({ refreshToken: second.refreshToken })
      .expect(200); // the other device is untouched
  });

  it("rotation does NOT extend the session's lifetime", async () => {
    // Otherwise an attacker refreshing quietly in the background could keep a
    // session alive forever, and the 30-day limit would mean nothing.
    const { refreshToken } = await signUp();
    const before = await prisma.session.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });

    const res = await post("/api/auth/refresh")
      .send({ refreshToken })
      .expect(200);
    const after = await prisma.session.findUnique({
      where: { tokenHash: hashToken(res.body.refreshToken) },
    });

    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
  });

  it("records WHY each session ended", async () => {
    // "My session ended and I don't know why" is otherwise unanswerable.
    const { refreshToken } = await signUp();
    await post("/api/auth/refresh").send({ refreshToken }).expect(200);

    const old = await prisma.session.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    expect(old!.revokedReason).toBe("rotated");
  });

  it("an expired session is refused", async () => {
    const { refreshToken } = await signUp();
    await prisma.session.updateMany({
      where: { tokenHash: hashToken(refreshToken) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await post("/api/auth/refresh").send({ refreshToken }).expect(401);
  });

  it("a deactivated account cannot refresh", async () => {
    const { refreshToken, user } = await signUp();
    await prisma.user.update({
      where: { id: user.id },
      data: { isActive: false },
    });

    await post("/api/auth/refresh").send({ refreshToken }).expect(401);
  });
});

describe("sessions — the device list", () => {
  beforeEach(resetDb);

  it("lists live sessions and marks the current one", async () => {
    const first = await signUp();
    await signIn();

    const res = await request(app)
      .get(`/api/auth/sessions?refreshToken=${first.refreshToken}`)
      .set("Authorization", `Bearer ${first.token}`)
      .expect(200);

    expect(res.body).toHaveLength(2);
    expect(res.body.filter((s: { current: boolean }) => s.current)).toHaveLength(
      1
    );
  });

  it("does not list revoked sessions", async () => {
    const first = await signUp();
    const second = await signIn();
    await post("/api/auth/logout")
      .send({ refreshToken: second.refreshToken })
      .expect(204);

    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", `Bearer ${first.token}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
  });

  it("ending one device by id works", async () => {
    const first = await signUp();
    const second = await signIn();

    const target = await prisma.session.findUnique({
      where: { tokenHash: hashToken(second.refreshToken) },
    });

    await request(app)
      .delete(`/api/auth/sessions/${target!.id}`)
      .set("Authorization", `Bearer ${first.token}`)
      .expect(204);

    await post("/api/auth/refresh")
      .send({ refreshToken: second.refreshToken })
      .expect(401);
  });

  it("cannot end another user's session by guessing its id", async () => {
    const mine = await signUp("me@test.com");
    const theirs = await signUp("them@test.com");

    const victim = await prisma.session.findUnique({
      where: { tokenHash: hashToken(theirs.refreshToken) },
    });

    await request(app)
      .delete(`/api/auth/sessions/${victim!.id}`)
      .set("Authorization", `Bearer ${mine.token}`)
      .expect(404);

    // And theirs still works.
    await post("/api/auth/refresh")
      .send({ refreshToken: theirs.refreshToken })
      .expect(200);
  });

  it("sign out other devices keeps the caller signed in", async () => {
    // Signing yourself out while pressing "sign out OTHER devices" would be a
    // confusing result.
    const first = await signUp();
    const second = await signIn();

    const res = await post("/api/auth/sessions/revoke-others")
      .set("Authorization", `Bearer ${first.token}`)
      .send({ refreshToken: first.refreshToken })
      .expect(200);

    expect(res.body.revoked).toBe(1);
    await post("/api/auth/refresh")
      .send({ refreshToken: first.refreshToken })
      .expect(200);
    await post("/api/auth/refresh")
      .send({ refreshToken: second.refreshToken })
      .expect(401);
  });
});

describe("sessions — password change", () => {
  beforeEach(resetDb);

  it("signs out every other device", async () => {
    // The point, not a side effect: people change a password because they
    // think someone else has access. Leaving that someone's session alive
    // defeats the exercise — and worse, leaves the user believing it's fixed.
    const first = await signUp();
    const second = await signIn();

    const res = await post("/api/auth/change-password")
      .set("Authorization", `Bearer ${first.token}`)
      .send({
        currentPassword: "correct horse battery",
        newPassword: "a brand new password",
        refreshToken: first.refreshToken,
      })
      .expect(200);

    expect(res.body.revokedSessions).toBe(1);
    await post("/api/auth/refresh")
      .send({ refreshToken: second.refreshToken })
      .expect(401);
  });

  it("keeps the session that changed the password", async () => {
    const first = await signUp();

    await post("/api/auth/change-password")
      .set("Authorization", `Bearer ${first.token}`)
      .send({
        currentPassword: "correct horse battery",
        newPassword: "a brand new password",
        refreshToken: first.refreshToken,
      })
      .expect(200);

    await post("/api/auth/refresh")
      .send({ refreshToken: first.refreshToken })
      .expect(200);
  });

  it("refuses a wrong current password", async () => {
    const first = await signUp();
    await post("/api/auth/change-password")
      .set("Authorization", `Bearer ${first.token}`)
      .send({ currentPassword: "wrong", newPassword: "a brand new password" })
      .expect(401);
  });

  it("the new password is what actually logs you in afterwards", async () => {
    const first = await signUp();
    await post("/api/auth/change-password")
      .set("Authorization", `Bearer ${first.token}`)
      .send({
        currentPassword: "correct horse battery",
        newPassword: "a brand new password",
        refreshToken: first.refreshToken,
      })
      .expect(200);

    await post("/api/auth/login")
      .send({ email: "founder@test.com", password: "correct horse battery" })
      .expect(401);
    await post("/api/auth/login")
      .send({ email: "founder@test.com", password: "a brand new password" })
      .expect(200);
  });
});

describe("sessions — housekeeping", () => {
  beforeEach(resetDb);

  it("purges long-expired sessions without touching live ones", async () => {
    // Rotation writes a row on every refresh, so an active user generates one
    // every fifteen minutes. Left alone the table grows without bound.
    const { refreshToken } = await signUp();
    await prisma.session.create({
      data: {
        userId: (await prisma.user.findFirstOrThrow()).id,
        companyId: (await prisma.company.findFirstOrThrow()).id,
        tokenHash: hashToken("ancient"),
        familyId: "old-family",
        expiresAt: new Date(Date.now() - 30 * 86_400_000),
      },
    });

    const purged = await purgeExpiredSessions(7);
    expect(purged).toBe(1);

    // The live one survives.
    await post("/api/auth/refresh").send({ refreshToken }).expect(200);
  });
});
