/**
 * Goods receipt + supplier returns (P1-7).
 *
 * PRD §10's flow: Purchase Order → Goods Receipt → Inventory, and the reverse
 * path Received Stock → Supplier Return → Stock Decrease.
 *
 * Two rules this file defends:
 *   1. Only ACCEPTED goods enter stock. Rejected goods are recorded so the
 *      supplier can be chased, but never become inventory.
 *   2. The ACTUAL cost charged moves the weighted average — not the quoted
 *      price. Inventory is worth what you paid.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import * as service from "./supplier-return.service.js";
import * as poService from "../purchase-orders/po.service.js";
import * as stockService from "../stock/stock.service.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";

async function expectAppError(promise: Promise<unknown>, statusCode: number) {
  const err = await promise.then(
    () => null,
    (e) => e
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).statusCode).toBe(statusCode);
  return err as AppError;
}

/** A placed PO for 100 units at ₹20, ready to receive against. */
async function poSetup() {
  const base = await createTestCompany();
  const supplier = await prisma.supplier.create({
    data: { companyId: base.company.id, name: "Acme Wholesale" },
  });

  const po = await poService.createPO(base.company.id, base.user.id, {
    supplierId: supplier.id,
    lines: [{ productId: base.product.id, quantity: 100, unitCost: 20 }],
  } as Parameters<typeof poService.createPO>[2]);
  await poService.changeStatus(base.company.id, po.id, "ORDERED");

  const full = await poService.getPO(base.company.id, po.id);
  const lineId = full.lines[0]!.id;

  const receive = (
    quantity: number,
    extra: Record<string, unknown> = {}
  ) =>
    poService.receivePO(base.company.id, base.user.id, po.id, {
      locationId: base.location.id,
      lines: [{ lineId, quantity, ...extra }],
    } as Parameters<typeof poService.receivePO>[3]);

  const level = () =>
    stockService
      .getStockLevel(base.company.id, base.product.id, base.location.id)
      .then(Number);

  const avgCost = async () =>
    Number(
      (await prisma.product.findUnique({
        where: { id: base.product.id },
        select: { avgCost: true },
      }))!.avgCost
    );

  return { ...base, supplier, po, lineId, receive, level, avgCost };
}

describe("goods receipt — the document", () => {
  beforeEach(resetDb);

  it("receiving now produces a receipt, not just a bumped counter", async () => {
    const { company, receive } = await poSetup();
    const result = await receive(30);

    expect(result.receipt).toBeDefined();
    expect(result.receipt.number).toBe(1);

    const grn = await service.getGoodsReceipt(company.id, result.receipt.id);
    expect(grn.lines).toHaveLength(1);
    expect(Number(grn.lines[0]!.acceptedQty)).toBe(30);
  });

  it("records rejected goods WITHOUT putting them into stock", async () => {
    // The headline rule. 30 arrived, 5 were broken — only 25 are yours.
    const { company, receive, level } = await poSetup();
    const result = await receive(25, {
      rejectedQty: 5,
      rejectReason: "Crushed in transit",
    });

    expect(await level()).toBe(25); // NOT 30

    const grn = await service.getGoodsReceipt(company.id, result.receipt.id);
    expect(Number(grn.lines[0]!.acceptedQty)).toBe(25);
    expect(Number(grn.lines[0]!.rejectedQty)).toBe(5);
    expect(grn.lines[0]!.rejectReason).toBe("Crushed in transit");
  });

  it("rejected goods don't count towards fulfilling the order", async () => {
    // 100 ordered; 60 accepted and 40 rejected still leaves 40 outstanding,
    // because a broken unit doesn't fulfil anything.
    const { company, po, receive } = await poSetup();
    await receive(60, { rejectedQty: 40 });

    const fresh = await poService.getPO(company.id, po.id);
    expect(Number(fresh.lines[0]!.receivedQty)).toBe(60);
    expect(fresh.status).toBe("PARTIAL"); // not RECEIVED

    // The remaining 40 can still be received.
    await receive(40);
    const done = await poService.getPO(company.id, po.id);
    expect(done.status).toBe("RECEIVED");
  });

  it("still refuses to accept MORE than was ordered", async () => {
    const { receive } = await poSetup();
    await expectAppError(receive(101), 400);
  });

  it("numbers receipts per company from 1", async () => {
    const { receive } = await poSetup();
    const a = await receive(10);
    const b = await receive(10);
    expect(a.receipt.number).toBe(1);
    expect(b.receipt.number).toBe(2);
  });

  it("lists receipts for a purchase order", async () => {
    const { company, po, receive } = await poSetup();
    await receive(10);
    await receive(20);

    const { items, total } = await service.listGoodsReceipts(company.id, {
      purchaseOrderId: po.id,
      take: 50,
      skip: 0,
    });
    expect(total).toBe(2);
    expect(items[0]!.purchaseOrder.number).toBe(po.number);
  });
});

describe("goods receipt — actual cost", () => {
  beforeEach(resetDb);

  it("the ACTUAL cost charged moves the average, not the quoted price", async () => {
    // Ordered at ₹20; supplier actually charged ₹25. The stock is worth what
    // we paid — otherwise every valuation is built on a quote nobody honoured.
    const { receive, avgCost } = await poSetup();
    await receive(10, { actualUnitCost: 25 });

    expect(await avgCost()).toBe(25);
  });

  it("falls back to the quoted price when no actual cost is given", async () => {
    const { receive, avgCost } = await poSetup();
    await receive(10);
    expect(await avgCost()).toBe(20);
  });

  it("stamps the actual cost on the stock movement", async () => {
    const { company, receive } = await poSetup();
    await receive(10, { actualUnitCost: 25 });

    const move = await prisma.stockMovement.findFirst({
      where: { companyId: company.id, type: "PURCHASE" },
    });
    expect(Number(move!.unitCost)).toBe(25);
    expect(Number(move!.costAtTime)).toBe(25);
  });
});

describe("supplier returns — sending goods back", () => {
  beforeEach(resetDb);

  it("stock decreases when SENT, not when drafted", async () => {
    // A draft return is a plan, not a dispatch. Deducting stock for a plan
    // would leave the shelf lying about what's on it.
    const { company, user, product, location, supplier, receive, level } =
      await poSetup();
    await receive(50);
    expect(await level()).toBe(50);

    const ret = await service.createSupplierReturn(company.id, user.id, {
      supplierId: supplier.id,
      locationId: location.id,
      lines: [{ productId: product.id, quantity: 8 }],
    } as Parameters<typeof service.createSupplierReturn>[2]);

    expect(ret.status).toBe("DRAFT");
    expect(await level()).toBe(50); // nothing yet

    await service.sendSupplierReturn(company.id, user.id, ret.id);
    expect(await level()).toBe(42); // NOW
  });

  it("writes a RETURN_OUT movement — the enum value nothing used before", async () => {
    const { company, user, product, location, supplier, receive } =
      await poSetup();
    await receive(50);

    const ret = await service.createSupplierReturn(company.id, user.id, {
      supplierId: supplier.id,
      locationId: location.id,
      lines: [{ productId: product.id, quantity: 8 }],
    } as Parameters<typeof service.createSupplierReturn>[2]);
    await service.sendSupplierReturn(company.id, user.id, ret.id);

    const move = await prisma.stockMovement.findFirst({
      where: { companyId: company.id, type: "RETURN_OUT" },
    });
    expect(move).not.toBeNull();
    expect(Number(move!.quantity)).toBe(-8); // outgoing
    expect(move!.reference).toBe("SRT-0001");
  });

  it("cannot send back more than is on the shelf", async () => {
    const { company, user, product, location, supplier, receive, level } =
      await poSetup();
    await receive(5);

    const ret = await service.createSupplierReturn(company.id, user.id, {
      supplierId: supplier.id,
      locationId: location.id,
      lines: [{ productId: product.id, quantity: 6 }],
    } as Parameters<typeof service.createSupplierReturn>[2]);

    await expectAppError(
      service.sendSupplierReturn(company.id, user.id, ret.id),
      400
    );
    expect(await level()).toBe(5); // untouched
  });

  it("references the goods receipt the items arrived on", async () => {
    // PRD §10 asks for this link — it's how "which delivery was this from?"
    // gets an answer.
    const { company, user, product, location, supplier, receive } =
      await poSetup();
    const result = await receive(20);

    const ret = await service.createSupplierReturn(company.id, user.id, {
      supplierId: supplier.id,
      locationId: location.id,
      goodsReceiptId: result.receipt.id,
      reason: "Wrong variant shipped",
      lines: [{ productId: product.id, quantity: 3 }],
    } as Parameters<typeof service.createSupplierReturn>[2]);

    expect(ret.goodsReceiptId).toBe(result.receipt.id);
    expect(ret.reason).toBe("Wrong variant shipped");
  });

  it("defaults the return value to what the stock is carried at", async () => {
    const { company, user, product, location, supplier, receive } =
      await poSetup();
    await receive(20, { actualUnitCost: 25 });

    const ret = await service.createSupplierReturn(company.id, user.id, {
      supplierId: supplier.id,
      locationId: location.id,
      lines: [{ productId: product.id, quantity: 3 }],
    } as Parameters<typeof service.createSupplierReturn>[2]);

    expect(Number(ret.lines[0]!.unitCost)).toBe(25);
  });
});

describe("supplier returns — status flow", () => {
  beforeEach(resetDb);

  async function draftReturn() {
    const s = await poSetup();
    await s.receive(50);
    const ret = await service.createSupplierReturn(s.company.id, s.user.id, {
      supplierId: s.supplier.id,
      locationId: s.location.id,
      lines: [{ productId: s.product.id, quantity: 5 }],
    } as Parameters<typeof service.createSupplierReturn>[2]);
    return { ...s, ret };
  }

  it("can't complete before sending", async () => {
    const { company, ret } = await draftReturn();
    await expectAppError(
      service.completeSupplierReturn(company.id, ret.id),
      409
    );
  });

  it("completes once sent", async () => {
    const { company, user, ret } = await draftReturn();
    await service.sendSupplierReturn(company.id, user.id, ret.id);
    const done = await service.completeSupplierReturn(company.id, ret.id);
    expect(done.status).toBe("COMPLETED");
    expect(done.completedAt).not.toBeNull();
  });

  it("can't send twice", async () => {
    const { company, user, ret } = await draftReturn();
    await service.sendSupplierReturn(company.id, user.id, ret.id);
    await expectAppError(
      service.sendSupplierReturn(company.id, user.id, ret.id),
      409
    );
  });

  it("can cancel a draft, but not once the goods have gone", async () => {
    const { company, user, ret } = await draftReturn();
    const cancelled = await service.cancelSupplierReturn(company.id, ret.id);
    expect(cancelled.status).toBe("CANCELLED");

    const second = await draftReturn();
    await service.sendSupplierReturn(
      second.company.id,
      second.user.id,
      second.ret.id
    );
    const err = await expectAppError(
      service.cancelSupplierReturn(second.company.id, second.ret.id),
      409
    );
    expect(err.message).toContain("adjustment");
  });

  it("numbers returns per company from 1", async () => {
    const { ret } = await draftReturn();
    expect(ret.number).toBe(1);
    expect(service.srtRef(ret.number)).toBe("SRT-0001");
  });
});

describe("supplier returns — tenant isolation", () => {
  beforeEach(resetDb);

  it("A cannot return against B's supplier", async () => {
    const a = await createTestCompany("Alpha");
    const b = await createTestCompany("Beta");
    const bSupplier = await prisma.supplier.create({
      data: { companyId: b.company.id, name: "Beta's Vendor" },
    });

    await expectAppError(
      service.createSupplierReturn(a.company.id, a.user.id, {
        supplierId: bSupplier.id,
        locationId: a.location.id,
        lines: [{ productId: a.product.id, quantity: 1 }],
      } as Parameters<typeof service.createSupplierReturn>[2]),
      404
    );
  });

  it("A cannot read B's goods receipt", async () => {
    const a = await createTestCompany("Alpha");
    const b = await poSetup();
    const result = await b.receive(10);

    await expectAppError(
      service.getGoodsReceipt(a.company.id, result.receipt.id),
      404
    );
  });
});
