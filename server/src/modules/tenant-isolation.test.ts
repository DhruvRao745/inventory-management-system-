/**
 * Cross-tenant isolation — the tests that keep the multi-tenant promise.
 *
 * One database serves every customer, separated only by a companyId column.
 * The entire business rests on that column being checked on every single
 * read and write. A single query that filters by id alone leaks one
 * customer's data to another.
 *
 * The audit found the SERVICE code does this correctly and consistently
 * (findFirst with companyId, then act by id). What it did not find was
 * tests. One isolation test existed, in stock.service.test.ts. This file is
 * the missing matrix, so that a future refactor which drops a companyId
 * filter fails here instead of in production.
 *
 * Guessing UUIDs is the threat model: company A is assumed to KNOW a real id
 * belonging to company B. Every test below hands A a genuine B id and
 * requires the system to behave as though it does not exist.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../middleware/error.js";
import * as stockService from "./stock/stock.service.js";
import * as invService from "./invoices/inv.service.js";
import * as poService from "./purchase-orders/po.service.js";
import * as productService from "./products/product.service.js";
import { resetDb, createTestCompany } from "../test/helpers.js";

/** Assert a call fails with a specific HTTP status. */
async function expectAppError(promise: Promise<unknown>, statusCode: number) {
  const err = await promise.then(
    () => null,
    (e) => e
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).statusCode).toBe(statusCode);
  return err as AppError;
}

/** Two fully-populated, unrelated businesses. */
async function twoCompanies() {
  const a = await createTestCompany("Alpha Traders");
  const b = await createTestCompany("Beta Supplies");

  const bSupplier = await prisma.supplier.create({
    data: { companyId: b.company.id, name: "Beta's Vendor" },
  });
  const bCustomer = await prisma.customer.create({
    data: { companyId: b.company.id, name: "Beta's Buyer" },
  });

  // Give B some real stock so "not enough stock" can never be the reason a
  // test passes — the refusal must come from ownership, not scarcity.
  await stockService.createMovement(b.company.id, b.user.id, {
    productId: b.product.id,
    locationId: b.location.id,
    type: "PURCHASE",
    quantity: 500,
  });

  return { a, b, bSupplier, bCustomer };
}

describe("tenant isolation — stock ledger", () => {
  beforeEach(resetDb);

  it("A cannot move B's product", async () => {
    const { a, b } = await twoCompanies();
    await expectAppError(
      stockService.createMovement(a.company.id, a.user.id, {
        productId: b.product.id, // B's product, real id
        locationId: a.location.id,
        type: "PURCHASE",
        quantity: 10,
      }),
      404
    );
  });

  it("A cannot move stock into B's location", async () => {
    const { a, b } = await twoCompanies();
    await expectAppError(
      stockService.createMovement(a.company.id, a.user.id, {
        productId: a.product.id,
        locationId: b.location.id, // B's shelf
        type: "PURCHASE",
        quantity: 10,
      }),
      404
    );
  });

  it("A cannot transfer B's stock, nor into B's location", async () => {
    const { a, b } = await twoCompanies();
    const aSecond = await prisma.location.create({
      data: { companyId: a.company.id, name: "A Godown" },
    });
    await stockService.createMovement(a.company.id, a.user.id, {
      productId: a.product.id,
      locationId: a.location.id,
      type: "PURCHASE",
      quantity: 50,
    });

    // B's product entirely
    await expectAppError(
      stockService.transfer(a.company.id, a.user.id, {
        productId: b.product.id,
        fromLocationId: b.location.id,
        toLocationId: aSecond.id,
        quantity: 1,
      }),
      404
    );

    // A's own product, but siphoned into B's location
    await expectAppError(
      stockService.transfer(a.company.id, a.user.id, {
        productId: a.product.id,
        fromLocationId: a.location.id,
        toLocationId: b.location.id,
        quantity: 1,
      }),
      404
    );

    // B's stock must be untouched by any of the above
    expect(
      Number(await stockService.getStockLevel(b.company.id, b.product.id, b.location.id))
    ).toBe(500);
  });

  it("A's stock levels and movement history never include B's rows", async () => {
    const { a, b } = await twoCompanies();
    await stockService.createMovement(a.company.id, a.user.id, {
      productId: a.product.id,
      locationId: a.location.id,
      type: "PURCHASE",
      quantity: 7,
    });

    const levels = await stockService.stockLevels(a.company.id, {} as never);
    expect(levels).toHaveLength(1);
    expect(levels[0]!.product.id).toBe(a.product.id);

    const history = await stockService.listMovements(a.company.id, {
      take: 100,
      skip: 0,
    } as never);
    expect(history.total).toBe(1);
    expect(history.items.every((m) => m.product.id === a.product.id)).toBe(true);
  });
});

describe("tenant isolation — invoices", () => {
  beforeEach(resetDb);

  it("A cannot put B's product on an invoice", async () => {
    const { a, b } = await twoCompanies();
    await expectAppError(
      invService.createInvoice(a.company.id, a.user.id, {
        customerName: "Walk-in",
        locationId: a.location.id,
        lines: [{ productId: b.product.id, quantity: 1, unitPrice: 10 }],
      } as Parameters<typeof invService.createInvoice>[2]),
      400
    );
  });

  it("A cannot invoice out of B's location", async () => {
    const { a, b } = await twoCompanies();
    await expectAppError(
      invService.createInvoice(a.company.id, a.user.id, {
        customerName: "Walk-in",
        locationId: b.location.id,
        lines: [{ productId: a.product.id, quantity: 1, unitPrice: 10 }],
      } as Parameters<typeof invService.createInvoice>[2]),
      404
    );
  });

  it("A cannot attach B's customer to its own invoice", async () => {
    const { a, bCustomer } = await twoCompanies();
    await expectAppError(
      invService.createInvoice(a.company.id, a.user.id, {
        customerName: "Walk-in",
        customerId: bCustomer.id,
        locationId: a.location.id,
        lines: [{ productId: a.product.id, quantity: 1, unitPrice: 10 }],
      } as Parameters<typeof invService.createInvoice>[2]),
      400
    );
  });

  it("A cannot read, issue or cancel B's invoice by id", async () => {
    const { a, b } = await twoCompanies();
    const bInvoice = await invService.createInvoice(b.company.id, b.user.id, {
      customerName: "Beta's Buyer",
      locationId: b.location.id,
      lines: [{ productId: b.product.id, quantity: 2, unitPrice: 10 }],
    } as Parameters<typeof invService.createInvoice>[2]);

    await expectAppError(invService.getInvoice(a.company.id, bInvoice.id), 404);
    await expectAppError(
      invService.issueInvoice(a.company.id, a.user.id, bInvoice.id),
      404
    );
    await expectAppError(
      invService.cancelInvoice(a.company.id, a.user.id, bInvoice.id),
      404
    );
    await expectAppError(
      invService.payInvoice(a.company.id, a.user.id, bInvoice.id),
      404
    );

    // Still a pristine draft, and B's stock never moved.
    const fresh = await invService.getInvoice(b.company.id, bInvoice.id);
    expect(fresh.status).toBe("DRAFT");
    expect(
      Number(await stockService.getStockLevel(b.company.id, b.product.id, b.location.id))
    ).toBe(500);
  });

  it("invoice numbering is per company — both start at 1", async () => {
    const { a, b } = await twoCompanies();
    const mk = (c: typeof a) =>
      invService.createInvoice(c.company.id, c.user.id, {
        customerName: "Walk-in",
        locationId: c.location.id,
        lines: [{ productId: c.product.id, quantity: 1, unitPrice: 10 }],
      } as Parameters<typeof invService.createInvoice>[2]);

    expect((await mk(a)).number).toBe(1);
    expect((await mk(b)).number).toBe(1); // not 2 — sequences are tenant-scoped
    expect((await mk(a)).number).toBe(2);
  });
});

describe("tenant isolation — purchase orders", () => {
  beforeEach(resetDb);

  it("A cannot order from B's supplier", async () => {
    const { a, bSupplier } = await twoCompanies();
    await expectAppError(
      poService.createPO(a.company.id, a.user.id, {
        supplierId: bSupplier.id,
        lines: [{ productId: a.product.id, quantity: 1, unitCost: 5 }],
      } as Parameters<typeof poService.createPO>[2]),
      404
    );
  });

  it("A cannot put B's product on its own PO", async () => {
    const { a, b } = await twoCompanies();
    const aSupplier = await prisma.supplier.create({
      data: { companyId: a.company.id, name: "Alpha's Vendor" },
    });
    await expectAppError(
      poService.createPO(a.company.id, a.user.id, {
        supplierId: aSupplier.id,
        lines: [{ productId: b.product.id, quantity: 1, unitCost: 5 }],
      } as Parameters<typeof poService.createPO>[2]),
      400
    );
  });

  it("A cannot receive B's purchase order", async () => {
    const { a, b, bSupplier } = await twoCompanies();
    const bPo = await poService.createPO(b.company.id, b.user.id, {
      supplierId: bSupplier.id,
      lines: [{ productId: b.product.id, quantity: 10, unitCost: 5 }],
    } as Parameters<typeof poService.createPO>[2]);

    await expectAppError(poService.getPO(a.company.id, bPo.id), 404);
    await expectAppError(
      poService.receivePO(a.company.id, a.user.id, bPo.id, {
        locationId: a.location.id,
        lines: [{ lineId: bPo.lines[0]!.id, quantity: 10 }],
      } as Parameters<typeof poService.receivePO>[3]),
      404
    );
  });
});

describe("tenant isolation — products", () => {
  beforeEach(resetDb);

  it("A cannot read, edit or retire B's product by id", async () => {
    const { a, b } = await twoCompanies();

    await expectAppError(
      productService.getProduct(a.company.id, b.product.id),
      404
    );
    await expectAppError(
      productService.updateProduct(a.company.id, b.product.id, {
        name: "Hijacked",
      } as Parameters<typeof productService.updateProduct>[2]),
      404
    );
    await expectAppError(
      productService.deactivateProduct(a.company.id, b.product.id),
      404
    );

    const untouched = await productService.getProduct(
      b.company.id,
      b.product.id
    );
    expect(untouched.name).toBe("Test Widget");
    expect(untouched.isActive).toBe(true);
  });

  it("A's product list never contains B's products", async () => {
    const { a } = await twoCompanies();
    const list = await productService.listProducts(a.company.id, {
      take: 100,
      skip: 0,
    } as never);
    expect(list.total).toBe(1);
    expect(list.items[0]!.id).toBe(a.product.id);
  });

  it("the same SKU may exist in both companies independently", async () => {
    // Proof the unique index is (companyId, sku) and not sku alone —
    // one tenant must never be able to squat another tenant's product codes.
    const { a, b } = await twoCompanies();
    const aSku = await prisma.product.findFirst({
      where: { companyId: a.company.id },
      select: { sku: true },
    });
    const bSku = await prisma.product.findFirst({
      where: { companyId: b.company.id },
      select: { sku: true },
    });
    expect(aSku!.sku).toBe(bSku!.sku);
  });
});
