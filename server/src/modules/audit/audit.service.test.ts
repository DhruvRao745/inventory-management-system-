/**
 * Audit history (P2-6, PRD §15).
 *
 * "Every important action must be traceable."
 *
 * The gap this closes: the old activity feed INFERRED history from tables that
 * happen to carry timestamps. That works retroactively, which is genuinely
 * useful — but inference can only see what still exists, in its current state.
 * It can show you a product priced at ₹500. It cannot tell you the price was
 * ₹50 last Tuesday, who changed it, or that anything changed at all.
 *
 * The events that matter most to an audit are exactly the ones that leave no
 * trace in the final row: logins, failed logins, permission changes, price
 * edits, cancellations. Those have to be recorded as they happen.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { prisma } from "../../lib/prisma.js";
import { app } from "../../app.js";
import { diffFields, sanitise, recordAudit } from "../../lib/audit.js";
import * as productService from "../products/product.service.js";
import * as stockService from "../stock/stock.service.js";
import * as invService from "../invoices/inv.service.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";

const post = (path: string) => request(app).post(path);

function tokenFor(base: Awaited<ReturnType<typeof createTestCompany>>) {
  return jwt.sign(
    { userId: base.user.id, companyId: base.company.id, role: "ADMIN" },
    env.JWT_SECRET,
    { expiresIn: "15m" }
  );
}

async function logsFor(companyId: string, action?: string) {
  return prisma.auditLog.findMany({
    where: { companyId, ...(action ? { action } : {}) },
    orderBy: { createdAt: "desc" },
  });
}

describe("audit — the diff helpers", () => {
  it("keeps only what actually changed", async () => {
    // Storing whole rows makes every entry look alike and forces a reader to
    // diff by eye. "sellingPrice: 50 → 500" is the entry someone needs; the
    // nineteen unchanged fields are what hides it.
    const { before, after } = diffFields(
      { name: "Widget", sellingPrice: 50, sku: "W-1" },
      { name: "Widget", sellingPrice: 500, sku: "W-1" }
    );
    expect(Object.keys(after)).toEqual(["sellingPrice"]);
    expect(before.sellingPrice).toBe(50);
    expect(after.sellingPrice).toBe(500);
  });

  it("NEVER stores a password hash", async () => {
    // The audit log is read widely during investigations. Credentials in it
    // would make it the softest target in the system.
    const clean = sanitise({
      email: "a@b.com",
      passwordHash: "$2a$10$verysecret",
      name: "Someone",
    }) as Record<string, unknown>;

    expect(clean.passwordHash).toBeUndefined();
    expect(JSON.stringify(clean)).not.toContain("verysecret");
    expect(clean.email).toBe("a@b.com");
  });

  it("keeps decimals exact by storing them as strings", async () => {
    // JSON has no decimal type. A price silently becoming 49.99999999 in the
    // audit trail would undermine the one thing the trail is for.
    const { Prisma } = await import("@prisma/client");
    const clean = sanitise({
      price: new Prisma.Decimal("49.99"),
    }) as Record<string, unknown>;
    expect(clean.price).toBe("49.99");
    expect(typeof clean.price).toBe("string");
  });

  it("ignores updatedAt — noise, not signal", async () => {
    const { after } = diffFields(
      { name: "A", updatedAt: new Date("2020-01-01") },
      { name: "A", updatedAt: new Date("2026-01-01") }
    );
    expect(Object.keys(after)).toHaveLength(0);
  });
});

describe("audit — access events", () => {
  beforeEach(resetDb);

  async function signUp(email = "founder@test.com") {
    const res = await post("/api/auth/register")
      .send({
        companyName: "Test Co",
        name: "Founder",
        email,
        password: "correct horse battery",
      })
      .expect(201);
    return res.body as { token: string; refreshToken: string; user: { id: string } };
  }

  it("records a successful sign-in", async () => {
    await signUp();
    await post("/api/auth/login")
      .send({ email: "founder@test.com", password: "correct horse battery" })
      .expect(200);

    const company = await prisma.company.findFirstOrThrow();
    const logs = await logsFor(company.id, "login");
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]!.actorEmail).toBe("founder@test.com");
  });

  it("records a FAILED sign-in — the most useful entry in the log", async () => {
    // A burst of these is what an attack looks like from the inside. Nothing
    // in the old inferred feed could show it, because a failed login changes
    // no row anywhere.
    await signUp();
    await post("/api/auth/login")
      .send({ email: "founder@test.com", password: "wrong" })
      .expect(401);

    const company = await prisma.company.findFirstOrThrow();
    const logs = await logsFor(company.id, "login.failed");
    expect(logs).toHaveLength(1);
    expect(logs[0]!.actorEmail).toBe("founder@test.com");
  });

  it("records a password change without recording the password", async () => {
    const me = await signUp();
    await post("/api/auth/change-password")
      .set("Authorization", `Bearer ${me.token}`)
      .send({
        currentPassword: "correct horse battery",
        newPassword: "a brand new password",
        refreshToken: me.refreshToken,
      })
      .expect(200);

    const company = await prisma.company.findFirstOrThrow();
    const logs = await logsFor(company.id, "password.change");
    expect(logs).toHaveLength(1);
    const serialised = JSON.stringify(logs[0]);
    expect(serialised).not.toContain("a brand new password");
    expect(serialised).not.toContain("correct horse battery");
  });
});

describe("audit — permission changes", () => {
  beforeEach(resetDb);

  it("records who promoted whom, with before and after", async () => {
    // "Who made this person an admin, and when?" is unanswerable from the row
    // itself — it only shows the result.
    const base = await createTestCompany();
    const token = tokenFor(base);

    const staff = await prisma.user.create({
      data: {
        companyId: base.company.id,
        email: "staff@test.com",
        passwordHash: "x",
        name: "Staffer",
        role: "STAFF",
      },
    });

    await request(app)
      .patch(`/api/users/${staff.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "ADMIN" })
      .expect(200);

    const logs = await logsFor(base.company.id, "user.role_change");
    expect(logs).toHaveLength(1);
    expect((logs[0]!.before as Record<string, unknown>).role).toBe("STAFF");
    expect((logs[0]!.after as Record<string, unknown>).role).toBe("ADMIN");
    expect(logs[0]!.userId).toBe(base.user.id); // who did it
  });

  it("records a deactivation", async () => {
    const base = await createTestCompany();
    const token = tokenFor(base);
    const staff = await prisma.user.create({
      data: {
        companyId: base.company.id,
        email: "staff@test.com",
        passwordHash: "x",
        name: "Staffer",
        role: "STAFF",
      },
    });

    await request(app)
      .patch(`/api/users/${staff.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ isActive: false })
      .expect(200);

    const logs = await logsFor(base.company.id, "user.deactivate");
    expect(logs).toHaveLength(1);
  });
});

describe("audit — the price-change case", () => {
  beforeEach(resetDb);

  it("records a price edit with the old and new value", async () => {
    // THE example. The product row after the edit says ₹500 and nothing else;
    // no inference can recover that it used to be ₹20.
    const base = await createTestCompany();

    await productService.updateProduct(
      base.company.id,
      base.product.id,
      { sellingPrice: 500 } as Parameters<typeof productService.updateProduct>[2],
      base.user.id
    );

    const logs = await logsFor(base.company.id, "product.update");
    expect(logs).toHaveLength(1);
    expect((logs[0]!.before as Record<string, unknown>).sellingPrice).toBe("20");
    expect((logs[0]!.after as Record<string, unknown>).sellingPrice).toBe("500");
    expect(logs[0]!.userId).toBe(base.user.id);
  });

  it("writes nothing when nothing changed", async () => {
    // "User pressed save and altered nothing" is pure noise, and enough of it
    // makes the log something people stop reading.
    const base = await createTestCompany();
    await productService.updateProduct(
      base.company.id,
      base.product.id,
      { sellingPrice: 20 } as Parameters<typeof productService.updateProduct>[2],
      base.user.id
    );
    expect(await logsFor(base.company.id, "product.update")).toHaveLength(0);
  });
});

describe("audit — money and inventory decisions", () => {
  beforeEach(resetDb);

  async function stockedShop() {
    const base = await createTestCompany();
    await stockService.createMovement(base.company.id, base.user.id, {
      productId: base.product.id,
      locationId: base.location.id,
      type: "PURCHASE",
      quantity: 100,
      unitCost: 10,
    } as Parameters<typeof stockService.createMovement>[2]);
    return base;
  }

  it("records a payment", async () => {
    const base = await stockedShop();
    const inv = await invService.createInvoice(base.company.id, base.user.id, {
      customerName: "Walk-in",
      locationId: base.location.id,
      lines: [{ productId: base.product.id, quantity: 2, unitPrice: 100 }],
    } as Parameters<typeof invService.createInvoice>[2]);
    await invService.issueInvoice(base.company.id, base.user.id, inv.id);

    const { recordPayment } = await import("../payments/payment.service.js");
    await recordPayment(base.company.id, base.user.id, {
      invoiceId: inv.id,
      amount: 100,
      method: "CASH",
    } as Parameters<typeof recordPayment>[2]);

    const logs = await logsFor(base.company.id, "payment.record");
    expect(logs).toHaveLength(1);
    expect((logs[0]!.after as Record<string, unknown>).amount).toBe("100");
  });

  it("records an invoice cancellation", async () => {
    const base = await stockedShop();
    const inv = await invService.createInvoice(base.company.id, base.user.id, {
      customerName: "Walk-in",
      locationId: base.location.id,
      lines: [{ productId: base.product.id, quantity: 2, unitPrice: 100 }],
    } as Parameters<typeof invService.createInvoice>[2]);
    await invService.issueInvoice(base.company.id, base.user.id, inv.id);
    await invService.cancelInvoice(base.company.id, base.user.id, inv.id);

    const logs = await logsFor(base.company.id, "invoice.cancel");
    expect(logs).toHaveLength(1);
    expect(logs[0]!.summary).toMatch(/stock restored/i);
  });

  it("records the DECISION to reclassify stock, not just the movement", async () => {
    // The ledger records that stock moved between buckets. Only this says who
    // judged the goods damaged.
    const base = await stockedShop();
    await stockService.reclassifyStock(base.company.id, base.user.id, {
      productId: base.product.id,
      locationId: base.location.id,
      quantity: 5,
      fromStatus: "AVAILABLE",
      toStatus: "DAMAGED",
      note: "Crushed in transit",
    });

    const logs = await logsFor(base.company.id, "stock.reclassify");
    expect(logs).toHaveLength(1);
    expect((logs[0]!.after as Record<string, unknown>).note).toBe(
      "Crushed in transit"
    );
    expect(logs[0]!.userId).toBe(base.user.id);
  });

  it("does NOT log ordinary stock movements", async () => {
    // The ledger is already append-only and never edited — it IS an audit
    // trail, and a better one. Duplicating it would double writes on the
    // hottest path and bury the entries that matter.
    const base = await stockedShop();
    const all = await logsFor(base.company.id);
    expect(all.filter((l) => l.entity === "movement")).toHaveLength(0);
  });
});

describe("audit — the log survives with its operation, or not at all", () => {
  beforeEach(resetDb);

  it("a rolled-back transaction leaves NO audit entry", async () => {
    // The property that makes the log trustworthy: the audit row commits with
    // the thing it describes, or neither does. An entry asserting something
    // happened that was actually rolled back would be worse than no entry —
    // it would be a lie that reads as evidence.
    //
    // Tested on the transaction directly rather than through a service, so it
    // proves the guarantee itself rather than one caller's error handling.
    const base = await createTestCompany();

    await expect(
      prisma.$transaction(async (tx) => {
        await recordAudit(tx, {
          companyId: base.company.id,
          userId: base.user.id,
          action: "product.update",
          entity: "product",
          entityId: base.product.id,
          summary: "This must never be visible",
        });
        throw new Error("the operation failed after the audit write");
      })
    ).rejects.toThrow(/failed after/);

    expect(await logsFor(base.company.id, "product.update")).toHaveLength(0);
  });

  it("a committed transaction keeps its audit entry", async () => {
    // The other half — proving the test above isn't passing simply because
    // nothing is ever written.
    const base = await createTestCompany();

    await prisma.$transaction(async (tx) => {
      await recordAudit(tx, {
        companyId: base.company.id,
        userId: base.user.id,
        action: "product.update",
        entity: "product",
        entityId: base.product.id,
        summary: "This one survives",
      });
    });

    expect(await logsFor(base.company.id, "product.update")).toHaveLength(1);
  });
});

describe("audit — reading the log", () => {
  beforeEach(resetDb);

  it("filters by entity and returns one thing's whole history", async () => {
    const base = await createTestCompany();
    const token = tokenFor(base);

    await productService.updateProduct(
      base.company.id,
      base.product.id,
      { sellingPrice: 30 } as Parameters<typeof productService.updateProduct>[2],
      base.user.id
    );
    await productService.updateProduct(
      base.company.id,
      base.product.id,
      { sellingPrice: 40 } as Parameters<typeof productService.updateProduct>[2],
      base.user.id
    );

    const res = await request(app)
      .get(`/api/audit/entity/product/${base.product.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveLength(2);
    expect(res.body[0].actor).toBe(base.user.name);
  });

  it("never shows another company's log", async () => {
    const ours = await createTestCompany("Ours");
    const theirs = await createTestCompany("Theirs");
    const token = tokenFor(ours);

    await productService.updateProduct(
      theirs.company.id,
      theirs.product.id,
      { sellingPrice: 999 } as Parameters<typeof productService.updateProduct>[2],
      theirs.user.id
    );

    const res = await request(app)
      .get("/api/audit/log")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body.items).toHaveLength(0);
  });

  it("shows the attempted email for a failed login with no user", async () => {
    // Otherwise the row records that *somebody* failed, which helps nobody.
    await post("/api/auth/register")
      .send({
        companyName: "Test Co",
        name: "Founder",
        email: "founder@test.com",
        password: "correct horse battery",
      })
      .expect(201);
    await post("/api/auth/login")
      .send({ email: "founder@test.com", password: "wrong" })
      .expect(401);

    const login = await post("/api/auth/login")
      .send({ email: "founder@test.com", password: "correct horse battery" })
      .expect(200);

    const res = await request(app)
      .get("/api/audit/log?action=login.failed")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].actor.email).toBe("founder@test.com");
  });
});
