/**
 * API contract tests — the seam nothing else covers.
 *
 * WHY THIS FILE EXISTS
 *
 * Almost every test in this suite calls a service function directly. That is
 * fast and precise, and it is blind to an entire class of bug: everything that
 * happens BETWEEN the browser and the service.
 *
 * Two real failures made the case, both of which passed a fully green suite:
 *
 *   1. Three client call sites double-encoded their request bodies. Raising a
 *      sales return, recording a refund and recording a payment were all dead
 *      in the browser while 181 tests passed — because no test ever encoded a
 *      request body at all.
 *
 *   2. `publicCompany()` dropped `stateCode` from its response. The field
 *      saved correctly and vanished on the way back out, so the Settings form
 *      showed "Not set" for a value the database held. TypeScript was happy —
 *      the field is optional and `?? null` turns a missing one into a valid
 *      null.
 *
 * Both are RESPONSE-SHAPE and REQUEST-HANDLING failures. Neither is reachable
 * from a service test, because a service test never crosses HTTP.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *
 * It does not re-test business logic. Costing, concurrency, FEFO, GST
 * arithmetic and the reservation rules are covered properly elsewhere, and
 * duplicating them here would double the maintenance for no extra coverage.
 * These tests ask one question: does the wire contract hold?
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { prisma } from "../lib/prisma.js";
import { app } from "../app.js";
import { resetDb } from "../test/helpers.js";

const PASSWORD = "correct horse battery";

/** Register a company and return a working token pair plus ids. */
async function signUp(email = "founder@test.com", companyName = "Test Co") {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName, name: "Founder", email, password: PASSWORD })
    .expect(201);
  return res.body as {
    token: string;
    refreshToken: string;
    user: { id: string };
    company: { id: string };
  };
}

/** A company with a location and a stocked product, all created over HTTP. */
async function stockedCompany(email = "founder@test.com") {
  const auth = await signUp(email);
  const authed = (m: "get" | "post" | "patch" | "delete", path: string) =>
    request(app)[m](path).set("Authorization", `Bearer ${auth.token}`);

  const locations = await authed("get", "/api/locations").expect(200);
  const locationId = locations.body[0].id;

  const product = await authed("post", "/api/products")
    .send({
      sku: "CONTRACT-1",
      name: "Contract Widget",
      unit: "pcs",
      costPrice: 10,
      sellingPrice: 25,
    })
    .expect(201);

  await authed("post", "/api/stock/movements")
    .send({
      productId: product.body.id,
      locationId,
      type: "PURCHASE",
      quantity: 100,
      unitCost: 10,
    })
    .expect(201);

  return { auth, authed, locationId, productId: product.body.id as string };
}

describe("contract — response shapes the client depends on", () => {
  beforeEach(resetDb);

  it("/auth/me returns every company field Settings renders", async () => {
    // THE regression test for the stateCode bug. The Settings form seeds its
    // inputs from this response; a field missing here reads as "not set" on
    // screen however correct the database is, and TypeScript cannot see it
    // because these fields are optional.
    const auth = await signUp();
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${auth.token}`)
      .expect(200);

    for (const field of [
      "id",
      "name",
      "currency",
      "address",
      "phone",
      "email",
      "gstin",
      "pan",
      "stateCode",
      "sealText",
      "invoiceTerms",
    ]) {
      expect(res.body.company).toHaveProperty(field);
    }
    expect(res.body.user).toHaveProperty("role");
  });

  it("login returns the same company shape as /auth/me", async () => {
    // These are built by the same helper but reached by different paths, and
    // a shape that drifts between them is a bug nobody notices until a form
    // is blank after login but populated after a refresh.
    const auth = await signUp();
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "founder@test.com", password: PASSWORD })
      .expect(200);
    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${auth.token}`)
      .expect(200);

    expect(Object.keys(login.body.company).sort()).toEqual(
      Object.keys(me.body.company).sort()
    );
  });

  it("a saved company setting survives the round trip", async () => {
    // Save → read back. The stateCode bug lived exactly here: PATCH stored it,
    // GET /company returned it, and /auth/me — which the UI actually reads —
    // silently did not.
    const auth = await signUp();
    await request(app)
      .patch("/api/company")
      .set("Authorization", `Bearer ${auth.token}`)
      .send({ stateCode: "08" })
      .expect(200);

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${auth.token}`)
      .expect(200);

    expect(me.body.company.stateCode).toBe("08");
  });

  it("stock levels expose the full condition breakdown", async () => {
    const { authed } = await stockedCompany();
    const res = await authed("get", "/api/stock/levels").expect(200);

    for (const field of [
      "quantity",
      "sellable",
      "damaged",
      "quarantine",
      "expired",
      "reserved",
      "available",
      "lowStock",
    ]) {
      expect(res.body[0]).toHaveProperty(field);
    }
  });
});

describe("contract — request bodies are accepted as sent", () => {
  beforeEach(resetDb);

  it("creates an invoice from an ordinary JSON body", async () => {
    // The double-JSON.stringify bug produced a quoted STRING body, which
    // express.json() rejects in strict mode. Nothing caught it because no test
    // ever sent a body over the wire.
    const { authed, locationId, productId } = await stockedCompany();

    const res = await authed("post", "/api/invoices")
      .send({
        customerName: "Walk-in",
        locationId,
        lines: [{ productId, quantity: 2, unitPrice: 25 }],
      })
      .expect(201);

    expect(res.body.number).toBeGreaterThan(0);
    expect(res.body.lines).toHaveLength(1);
  });

  it("rejects a double-encoded body rather than accepting nonsense", async () => {
    // Proves the failure mode is a clean 4xx, not a silent partial write.
    const { auth, locationId, productId } = await stockedCompany();
    const payload = JSON.stringify({
      customerName: "Walk-in",
      locationId,
      lines: [{ productId, quantity: 2, unitPrice: 25 }],
    });

    const res = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${auth.token}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload)); // the bug, reproduced exactly

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.invoice.count()).toBe(0);
  });

  it("records a payment over HTTP", async () => {
    const { authed, locationId, productId } = await stockedCompany();
    const inv = await authed("post", "/api/invoices")
      .send({
        customerName: "Walk-in",
        locationId,
        lines: [{ productId, quantity: 2, unitPrice: 25 }],
      })
      .expect(201);
    await authed("post", `/api/invoices/${inv.body.id}/issue`).expect(200);

    const res = await authed("post", "/api/payments")
      .send({ invoiceId: inv.body.id, amount: 20, method: "CASH" })
      .expect(201);

    expect(Number(res.body.summary.paidAmount)).toBe(20);
  });

  it("reclassifies stock over HTTP", async () => {
    const { authed, locationId, productId } = await stockedCompany();

    await authed("post", "/api/stock/reclassify")
      .send({
        productId,
        locationId,
        quantity: 5,
        fromStatus: "AVAILABLE",
        toStatus: "DAMAGED",
        note: "contract test",
      })
      .expect(201);

    const levels = await authed("get", "/api/stock/levels").expect(200);
    expect(Number(levels.body[0].damaged)).toBe(5);
    expect(Number(levels.body[0].quantity)).toBe(100); // on hand unchanged
  });

  it("coerces query strings correctly", async () => {
    // Query params arrive as strings and several schemas coerce them. A schema
    // missing its coercion fails only over HTTP — a service test passes real
    // numbers and never notices.
    const { authed } = await stockedCompany();
    await authed("get", "/api/products?take=5&skip=0&includeInactive=true").expect(
      200
    );
    await authed("get", "/api/audit/log?take=10").expect(200);
  });
});

describe("contract — auth and authorization at the door", () => {
  beforeEach(resetDb);

  it("refuses an unauthenticated request", async () => {
    await request(app).get("/api/products").expect(401);
  });

  it("refuses a malformed token", async () => {
    await request(app)
      .get("/api/products")
      .set("Authorization", "Bearer not-a-real-token")
      .expect(401);
  });

  it("enforces role on a privileged route", async () => {
    // 403 not 401: we know exactly who this is, and they may not do it.
    const { auth } = await stockedCompany();
    const staff = await prisma.user.create({
      data: {
        companyId: (await prisma.company.findFirstOrThrow()).id,
        email: "staff@test.com",
        passwordHash: "not-a-real-hash",
        name: "Staffer",
        role: "STAFF",
      },
    });

    const jwt = (await import("jsonwebtoken")).default;
    const { env } = await import("../config/env.js");
    const staffToken = jwt.sign(
      { userId: staff.id, companyId: staff.companyId, role: "STAFF" },
      env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    await request(app)
      .post("/api/stock/reclassify")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({
        productId: "x",
        locationId: "y",
        quantity: 1,
        fromStatus: "AVAILABLE",
        toStatus: "DAMAGED",
      })
      .expect(403);

    expect(auth.token).toBeTruthy();
  });

  it("never returns another company's data", async () => {
    // The tenancy rule, checked at the HTTP layer rather than in a service —
    // a route that forgets its companyId filter is invisible to a service test
    // that always passes the right one.
    const ours = await stockedCompany("ours@test.com");
    const theirs = await stockedCompany("theirs@test.com");

    const res = await ours
      .authed("get", `/api/products/${theirs.productId}`)
      .expect(404);
    expect(res.body.error).toBeTruthy();

    const list = await ours.authed("get", "/api/products").expect(200);
    expect(
      list.body.items.some((p: { id: string }) => p.id === theirs.productId)
    ).toBe(false);
  });
});

describe("contract — errors are shaped, not leaked", () => {
  beforeEach(resetDb);

  it("returns a readable message for a validation failure", async () => {
    const { authed } = await stockedCompany();
    const res = await authed("post", "/api/products").send({ name: "" }).expect(400);
    expect(res.body).toHaveProperty("error");
    expect(typeof res.body.error).toBe("string");
  });

  it("does not leak a stack trace on a bad request", async () => {
    // A stack trace tells an attacker the framework, the file layout and often
    // the query. The client only ever needs the message.
    const { authed } = await stockedCompany();
    const res = await authed("post", "/api/stock/movements")
      .send({ productId: "nope", locationId: "nope", type: "SALE", quantity: 1 })
      .expect(404);

    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/at \w+ \(/); // stack frame shape
    expect(body).not.toMatch(/node_modules/);
  });

  it("404s an unknown API path instead of serving the app shell", async () => {
    await request(app).get("/api/no-such-thing").expect(404);
  });
});
