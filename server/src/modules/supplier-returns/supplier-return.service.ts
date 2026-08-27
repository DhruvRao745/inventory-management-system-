/**
 * Supplier returns (P1-7).
 *
 * PRD §10's flow, in reverse:
 *
 *     Received Stock → Supplier Return → Stock Decrease
 *
 * The mirror of sales returns, pointing the other way. Where a sales return
 * brings goods IN from a customer, this sends goods OUT to a supplier —
 * wrong item, faulty batch, over-delivery.
 *
 * `RETURN_OUT` has existed in the MovementType enum since the beginning and
 * has never been written by anything. This is what finally uses it.
 *
 * WHEN STOCK MOVES
 *
 * At SENT — when the goods physically leave. A draft return is a plan, not a
 * dispatch, and deducting stock for a plan would leave the shelf lying about
 * what's on it.
 *
 *     DRAFT → SENT → COMPLETED
 *        ↓      ↑
 *    CANCELLED  stock leaves here
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import {
  lockStock,
  lockCost,
  lockCounter,
  lockDocument,
  LOCKED_TX_OPTIONS,
} from "../../lib/locks.js";
import { costStockOut } from "../../lib/costing.js";
import { parseQuantity, formatQuantity, Dec } from "../../lib/quantity.js";
import { planAllocation, consumeAllocation } from "../stock/batch.service.js";
import type {
  CreateSupplierReturnInput,
  UpdateSupplierReturnInput,
  ListSupplierReturnsQuery,
} from "./supplier-return.schemas.js";

export function srtRef(number: number): string {
  return `SRT-${String(number).padStart(4, "0")}`;
}

const returnInclude = {
  supplier: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  lines: {
    include: {
      product: { select: { id: true, sku: true, name: true, unit: true } },
      goodsReceiptLine: {
        select: {
          id: true,
          acceptedQty: true,
          batchNumber: true,
          goodsReceipt: { select: { id: true, number: true } },
        },
      },
    },
  },
} as const;

export async function createSupplierReturn(
  companyId: string,
  userId: string,
  input: CreateSupplierReturnInput
) {
  return prisma.$transaction(async (tx) => {
    const supplier = await tx.supplier.findFirst({
      where: { id: input.supplierId, companyId },
    });
    if (!supplier) throw new AppError(404, "Supplier not found");

    const location = await tx.location.findFirst({
      where: { id: input.locationId, companyId },
    });
    if (!location) throw new AppError(404, "Location not found");

    if (input.goodsReceiptId) {
      const grn = await tx.goodsReceipt.findFirst({
        where: { id: input.goodsReceiptId, companyId },
      });
      if (!grn) throw new AppError(404, "Goods receipt not found");
    }

    const products = await tx.product.findMany({
      where: {
        id: { in: [...new Set(input.lines.map((l) => l.productId))] },
        companyId,
      },
      select: {
        id: true,
        name: true,
        unit: true,
        precision: true,
        avgCost: true,
      },
    });
    if (products.length !== new Set(input.lines.map((l) => l.productId)).size) {
      throw new AppError(400, "One or more products don't exist");
    }
    const productById = new Map(products.map((p) => [p.id, p]));

    // Validate every line before writing — a bad line 3 must not leave a
    // half-built return behind.
    const parsed = input.lines.map((l) => {
      const product = productById.get(l.productId)!;
      return {
        productId: l.productId,
        quantity: parseQuantity(l.quantity, product),
        // Default to what the stock is currently carried at, so the return's
        // value matches what leaving the shelf actually removes.
        unitCost:
          l.unitCost !== undefined
            ? new Prisma.Decimal(l.unitCost)
            : product.avgCost.toDecimalPlaces(2),
        goodsReceiptLineId: l.goodsReceiptLineId,
        notes: l.notes,
      };
    });

    await lockCounter(tx, companyId, "supplier-return");
    const last = await tx.supplierReturn.findFirst({
      where: { companyId },
      orderBy: { number: "desc" },
      select: { number: true },
    });

    return tx.supplierReturn.create({
      data: {
        companyId,
        number: (last?.number ?? 0) + 1,
        supplierId: input.supplierId,
        locationId: input.locationId,
        goodsReceiptId: input.goodsReceiptId,
        reason: input.reason,
        notes: input.notes,
        createdById: userId,
        lines: { create: parsed },
      },
      include: returnInclude,
    });
  }, LOCKED_TX_OPTIONS);
}

/**
 * The goods leave. Stock decreases HERE, not when the return was drafted.
 *
 * Uses the same oversell guard as every other outgoing path: you cannot send
 * back more than you actually hold.
 */
export async function sendSupplierReturn(
  companyId: string,
  userId: string,
  id: string
) {
  return prisma.$transaction(async (tx) => {
    await lockDocument(tx, "supplier-return", id);

    const ret = await tx.supplierReturn.findFirst({
      where: { id, companyId },
      include: {
        lines: { include: { product: { select: { name: true, unit: true, tracksBatch: true, batchStrategy: true } } } },
      },
    });
    if (!ret) throw new AppError(404, "Supplier return not found");
    if (ret.status !== "DRAFT") {
      throw new AppError(409, "Only a draft return can be sent");
    }

    // Stock locks first, then cost locks — the ordering rule from P1-3.
    await lockStock(
      tx,
      companyId,
      ret.lines.map((l) => ({
        productId: l.productId,
        locationId: ret.locationId,
      }))
    );
    await lockCost(
      tx,
      companyId,
      ret.lines.map((l) => l.productId)
    );

    const ref = srtRef(ret.number);

    for (const line of ret.lines) {
      // Same oversell guard as sales and adjustments: you cannot send back
      // stock you don't hold.
      const sum = await tx.stockMovement.aggregate({
        where: {
          companyId,
          productId: line.productId,
          locationId: ret.locationId,
        },
        _sum: { quantity: true },
      });
      const onHand = sum._sum.quantity ?? new Dec(0);
      if (onHand.lessThan(line.quantity)) {
        throw new AppError(
          400,
          `Not enough stock of ${line.product.name}: only ${formatQuantity(onHand)} ${line.product.unit} at this location`
        );
      }

      // Batch-tracked goods pick lots the same way a sale does — the stock
      // physically leaving has to come from somewhere real.
      const plan = line.product.tracksBatch
        ? await planAllocation(
            tx,
            companyId,
            line.productId,
            ret.locationId,
            line.quantity,
            line.product.batchStrategy
          )
        : null;

      const costAtTime = await costStockOut(
        tx,
        companyId,
        line.productId,
        line.quantity
      );

      const movement = await tx.stockMovement.create({
        data: {
          companyId,
          productId: line.productId,
          locationId: ret.locationId,
          type: "RETURN_OUT",
          quantity: line.quantity.negated(), // outgoing
          unitCost: line.unitCost,
          costAtTime,
          reference: ref,
          note: `Returned to supplier on ${ref}`,
          createdById: userId,
        },
      });

      if (plan) await consumeAllocation(tx, movement.id, plan);
    }

    return tx.supplierReturn.update({
      where: { id: ret.id },
      data: { status: "SENT", sentAt: new Date() },
      include: returnInclude,
    });
  }, LOCKED_TX_OPTIONS);
}

/** The supplier has acknowledged or credited us. Paperwork only. */
export async function completeSupplierReturn(companyId: string, id: string) {
  const ret = await prisma.supplierReturn.findFirst({
    where: { id, companyId },
    select: { id: true, status: true },
  });
  if (!ret) throw new AppError(404, "Supplier return not found");
  if (ret.status !== "SENT") {
    throw new AppError(409, "Send the goods before completing the return");
  }

  return prisma.supplierReturn.update({
    where: { id: ret.id },
    data: { status: "COMPLETED", completedAt: new Date() },
    include: returnInclude,
  });
}

/** Call it off before the goods leave. */
export async function cancelSupplierReturn(companyId: string, id: string) {
  const ret = await prisma.supplierReturn.findFirst({
    where: { id, companyId },
    select: { id: true, status: true },
  });
  if (!ret) throw new AppError(404, "Supplier return not found");
  if (ret.status === "SENT" || ret.status === "COMPLETED") {
    throw new AppError(
      409,
      "The goods have already gone — this needs an adjustment, not a cancellation"
    );
  }
  if (ret.status === "CANCELLED") {
    throw new AppError(409, "This return is already cancelled");
  }

  return prisma.supplierReturn.update({
    where: { id: ret.id },
    data: { status: "CANCELLED" },
    include: returnInclude,
  });
}

export async function listSupplierReturns(
  companyId: string,
  q: ListSupplierReturnsQuery
) {
  const where = {
    companyId,
    ...(q.status ? { status: q.status } : {}),
    ...(q.supplierId ? { supplierId: q.supplierId } : {}),
    ...(q.number ? { number: q.number } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.supplierReturn.findMany({
      where,
      orderBy: { number: "desc" },
      take: q.take,
      skip: q.skip,
      include: returnInclude,
    }),
    prisma.supplierReturn.count({ where }),
  ]);

  return { items, total, take: q.take, skip: q.skip };
}

export async function getSupplierReturn(companyId: string, id: string) {
  const ret = await prisma.supplierReturn.findFirst({
    where: { id, companyId },
    include: returnInclude,
  });
  if (!ret) throw new AppError(404, "Supplier return not found");
  return ret;
}

export async function updateSupplierReturn(
  companyId: string,
  id: string,
  input: UpdateSupplierReturnInput
) {
  const existing = await prisma.supplierReturn.findFirst({
    where: { id, companyId },
    select: { id: true, status: true },
  });
  if (!existing) throw new AppError(404, "Supplier return not found");
  if (existing.status === "COMPLETED" || existing.status === "CANCELLED") {
    throw new AppError(409, "This return is closed");
  }

  return prisma.supplierReturn.update({
    where: { id: existing.id },
    data: { reason: input.reason, notes: input.notes },
    include: returnInclude,
  });
}

// ---------- Goods receipts (read side) ----------

const receiptInclude = {
  purchaseOrder: {
    select: {
      id: true,
      number: true,
      supplier: { select: { id: true, name: true } },
    },
  },
  location: { select: { id: true, name: true } },
  receivedBy: { select: { id: true, name: true } },
  lines: {
    include: {
      product: { select: { id: true, sku: true, name: true, unit: true } },
    },
  },
} as const;

export async function listGoodsReceipts(
  companyId: string,
  q: { purchaseOrderId?: string; take: number; skip: number }
) {
  const where = {
    companyId,
    ...(q.purchaseOrderId ? { purchaseOrderId: q.purchaseOrderId } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.goodsReceipt.findMany({
      where,
      orderBy: { number: "desc" },
      take: q.take,
      skip: q.skip,
      include: receiptInclude,
    }),
    prisma.goodsReceipt.count({ where }),
  ]);

  return { items, total, take: q.take, skip: q.skip };
}

export async function getGoodsReceipt(companyId: string, id: string) {
  const grn = await prisma.goodsReceipt.findFirst({
    where: { id, companyId },
    include: receiptInclude,
  });
  if (!grn) throw new AppError(404, "Goods receipt not found");
  return grn;
}
