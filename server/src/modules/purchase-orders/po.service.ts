/**
 * Purchase-order logic. The tricky bits live here: assigning the next
 * per-company number inside a transaction, validating that the supplier and
 * every product belong to the caller's company, and enforcing which status
 * changes are allowed.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import {
  lockStock,
  lockCounter,
  lockDocument,
  lockCost,
  LOCKED_TX_OPTIONS,
} from "../../lib/locks.js";
import { receiveIntoBatch } from "../stock/batch.service.js";
import { costStockIn } from "../../lib/costing.js";
import {
  Dec,
  parseQuantity,
  formatQuantity,
  type Decimal,
} from "../../lib/quantity.js";
import type {
  CreatePOInput,
  UpdatePOInput,
  ListPOQuery,
  ReceiveInput,
} from "./po.schemas.js";

// Display reference stamped on the stock movements a receipt creates.
function poRef(number: number): string {
  return `PO-${String(number).padStart(4, "0")}`;
}

// A minimal Prisma transaction client type (what the callbacks receive).
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// Confirm the supplier is ours; return it or throw 404.
async function assertSupplier(tx: Tx, companyId: string, supplierId: string) {
  const supplier = await tx.supplier.findFirst({
    where: { id: supplierId, companyId },
  });
  if (!supplier) throw new AppError(404, "Supplier not found");
  return supplier;
}

// Confirm every product on the lines is ours and active.
async function assertProducts(
  tx: Tx,
  companyId: string,
  productIds: string[]
) {
  const unique = [...new Set(productIds)];
  const found = await tx.product.findMany({
    where: { id: { in: unique }, companyId },
    select: {
      id: true,
      name: true,
      unit: true,
      precision: true,
      isActive: true,
    },
  });
  if (found.length !== unique.length) {
    throw new AppError(400, "One or more products don't exist");
  }
  if (found.some((p) => !p.isActive)) {
    throw new AppError(400, "Can't order a retired product");
  }
  return new Map(found.map((p) => [p.id, p]));
}

export async function createPO(
  companyId: string,
  createdById: string,
  input: CreatePOInput,
  /**
   * Where this order came from (P3-1). Omitted for a hand-raised PO; set to
   * "reorder" by the recommendation generator.
   */
  generatedFrom?: string
) {
  return prisma.$transaction(async (tx) => {
    await assertSupplier(tx, companyId, input.supplierId);
    const products = await assertProducts(
      tx,
      companyId,
      input.lines.map((l) => l.productId)
    );
    // Precision-check every line against its own product (P1-2).
    const qty = input.lines.map((l) =>
      parseQuantity(l.quantity, products.get(l.productId)!)
    );

    // Next number for THIS company. The advisory lock queues simultaneous
    // creates so they can't compute the same number; the
    // @@unique([companyId, number]) index remains the backstop.
    await lockCounter(tx, companyId, "purchase-order");

    const last = await tx.purchaseOrder.findFirst({
      where: { companyId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const number = (last?.number ?? 0) + 1;

    return tx.purchaseOrder.create({
      data: {
        companyId,
        createdById,
        supplierId: input.supplierId,
        number,
        notes: input.notes,
        generatedFrom: generatedFrom ?? null,
        expectedDate: input.expectedDate
          ? new Date(input.expectedDate)
          : undefined,
        lines: {
          create: input.lines.map((l, i) => ({
            productId: l.productId,
            quantity: qty[i]!,
            unitCost: l.unitCost,
          })),
        },
      },
      include: poInclude,
    });
  }, LOCKED_TX_OPTIONS);
}

const poInclude = {
  supplier: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  lines: {
    include: {
      product: { select: { id: true, sku: true, name: true, unit: true } },
    },
  },
} as const;

export async function listPOs(companyId: string, q: ListPOQuery) {
  const where = {
    companyId,
    ...(q.status ? { status: q.status } : {}),
    ...(q.supplierId ? { supplierId: q.supplierId } : {}),
    ...(q.number ? { number: q.number } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      orderBy: { number: "desc" },
      take: q.take,
      skip: q.skip,
      include: {
        supplier: { select: { id: true, name: true } },
        lines: { select: { quantity: true, unitCost: true } },
      },
    }),
    prisma.purchaseOrder.count({ where }),
  ]);

  // Flatten each PO to a list-friendly summary (item count + money total).
  const rows = items.map((po) => {
    const itemCount = po.lines.length;
    const totalCost = po.lines.reduce(
      // Decimal per line, then one Number() at the end — multiplying
      // Number()s per line is how 2.5 × 33.33 becomes 83.32499999999999.
      (sum, l) => sum.plus(l.unitCost.times(l.quantity)),
      new Dec(0)
    );
    return {
      id: po.id,
      number: po.number,
      status: po.status,
      supplier: po.supplier,
      notes: po.notes,
      expectedDate: po.expectedDate,
      createdAt: po.createdAt,
      itemCount,
      totalCost: Number(totalCost.toDecimalPlaces(2)),
    };
  });

  return { items: rows, total, take: q.take, skip: q.skip };
}

export async function getPO(companyId: string, id: string) {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id, companyId },
    include: poInclude,
  });
  if (!po) throw new AppError(404, "Purchase order not found");
  return po;
}

export async function updatePO(
  companyId: string,
  id: string,
  input: UpdatePOInput
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.purchaseOrder.findFirst({
      where: { id, companyId },
      select: { id: true, status: true },
    });
    if (!existing) throw new AppError(404, "Purchase order not found");
    if (existing.status !== "DRAFT") {
      throw new AppError(409, "Only draft purchase orders can be edited");
    }

    if (input.supplierId) {
      await assertSupplier(tx, companyId, input.supplierId);
    }
    let qty: Decimal[] = [];
    if (input.lines) {
      const products = await assertProducts(
        tx,
        companyId,
        input.lines.map((l) => l.productId)
      );
      // Precision-check BEFORE deleting the old lines, or a bad quantity on
      // line 4 leaves the order with no lines at all.
      qty = input.lines.map((l) =>
        parseQuantity(l.quantity, products.get(l.productId)!)
      );
      // Replace the lines wholesale — simplest correct approach for a draft.
      await tx.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: id } });
    }

    return tx.purchaseOrder.update({
      where: { id },
      data: {
        supplierId: input.supplierId,
        notes: input.notes === undefined ? undefined : input.notes,
        expectedDate:
          input.expectedDate === undefined
            ? undefined
            : input.expectedDate === null
              ? null
              : new Date(input.expectedDate),
        ...(input.lines
          ? {
              lines: {
                create: input.lines.map((l, i) => ({
                  productId: l.productId,
                  quantity: qty[i]!,
                  unitCost: l.unitCost,
                })),
              },
            }
          : {}),
      },
      include: poInclude,
    });
  });
}

export async function changeStatus(
  companyId: string,
  id: string,
  status: "ORDERED" | "CANCELLED"
) {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id, companyId },
    select: { id: true, status: true },
  });
  if (!po) throw new AppError(404, "Purchase order not found");

  // Allowed moves: DRAFT→ORDERED, DRAFT→CANCELLED, ORDERED→CANCELLED.
  // PARTIAL/RECEIVED are driven by receiving, not this endpoint.
  const allowed: Record<string, string[]> = {
    DRAFT: ["ORDERED", "CANCELLED"],
    ORDERED: ["CANCELLED"],
    PARTIAL: [],
    RECEIVED: [],
    CANCELLED: [],
  };
  if (!allowed[po.status]?.includes(status)) {
    throw new AppError(409, `Can't move a ${po.status} order to ${status}`);
  }

  return prisma.purchaseOrder.update({
    where: { id },
    data: { status },
    include: poInclude,
  });
}

/**
 * Receive stock against a PO. For each line the user reports how many arrived;
 * we write a PURCHASE movement into the ledger (so on-hand rises the normal,
 * event-sourced way) and bump that line's receivedQty. When every line is
 * fully received the PO becomes RECEIVED, otherwise PARTIAL.
 */
export async function receivePO(
  companyId: string,
  userId: string,
  id: string,
  input: ReceiveInput
) {
  return prisma.$transaction(async (tx) => {
    // Serialize receipts against THIS order before reading its counters —
    // otherwise two simultaneous receipts both read receivedQty = 0 and one
    // update is silently lost.
    await lockDocument(tx, "purchase-order", id);

    const po = await tx.purchaseOrder.findFirst({
      where: { id, companyId },
      include: { lines: true },
    });
    if (!po) throw new AppError(404, "Purchase order not found");
    if (po.status !== "ORDERED" && po.status !== "PARTIAL") {
      throw new AppError(
        409,
        "Only placed (ordered) purchase orders can be received"
      );
    }

    const location = await tx.location.findFirst({
      where: { id: input.locationId, companyId },
    });
    if (!location) throw new AppError(404, "Location not found");

    const lineById = new Map(po.lines.map((l) => [l.id, l]));

    // Products for precision + batch checks, fetched once.
    const productsById = new Map(
      (
        await tx.product.findMany({
          where: {
            id: {
              in: [
                ...new Set(
                  input.lines.map((r) => lineById.get(r.lineId)?.productId).filter(
                    (x): x is string => Boolean(x)
                  )
                ),
              ],
            },
          },
          select: {
            id: true,
            name: true,
            unit: true,
            precision: true,
            tracksBatch: true,
          },
        })
      ).map((p) => [p.id, p])
    );

    // Validate everything BEFORE writing anything: a receipt is never
    // half-recorded because line 3 turned out to be invalid.
    const received = new Map<string, Decimal>();
    const rejected = new Map<string, Decimal>();
    const actualCost = new Map<string, Prisma.Decimal>();

    for (const r of input.lines) {
      const line = lineById.get(r.lineId);
      if (!line) throw new AppError(400, "Unknown line on this order");
      const product = productsById.get(line.productId);
      if (!product) throw new AppError(400, "Unknown product on this order");

      const qty = parseQuantity(r.quantity, product);
      const remaining = line.quantity.minus(line.receivedQty);
      if (qty.greaterThan(remaining)) {
        throw new AppError(
          400,
          `Can't receive ${formatQuantity(qty)} — only ${formatQuantity(remaining)} ${product.unit} left to receive for that item`
        );
      }
      if (product.tracksBatch && !r.batchNumber) {
        throw new AppError(
          400,
          `${product.name} is batch-tracked — enter the batch number shown on the goods`
        );
      }

      // Rejected goods arrived but were refused. They are NOT checked against
      // the outstanding quantity, because they don't fulfil the order — a
      // delivery of 10 where 3 are broken leaves 3 still owed.
      const rej = r.rejectedQty
        ? parseQuantity(r.rejectedQty, product)
        : new Dec(0);

      received.set(r.lineId, qty);
      rejected.set(r.lineId, rej);
      // What we were ACTUALLY charged. Falls back to the quoted price.
      actualCost.set(
        r.lineId,
        r.actualUnitCost !== undefined
          ? new Prisma.Decimal(r.actualUnitCost)
          : line.unitCost
      );
    }

    // Receiving writes PURCHASE movements, so take the shelf locks too —
    // every ledger write goes through lockStock, without exception.
    await lockStock(
      tx,
      companyId,
      input.lines.map((r) => ({
        productId: lineById.get(r.lineId)!.productId,
        locationId: input.locationId,
      }))
    );
    // Receiving is THE event that moves the weighted average, so the cost
    // lock matters most here. Stock locks first, then cost — always.
    await lockCost(
      tx,
      companyId,
      input.lines.map((r) => lineById.get(r.lineId)!.productId)
    );

    // The delivery gets a DOCUMENT (P1-7). Before this, receiving left only a
    // bumped counter — you couldn't say "this pallet arrived Tuesday, three
    // were broken, and we were charged more than quoted".
    await lockCounter(tx, companyId, "goods-receipt");
    const lastGrn = await tx.goodsReceipt.findFirst({
      where: { companyId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const receipt = await tx.goodsReceipt.create({
      data: {
        companyId,
        number: (lastGrn?.number ?? 0) + 1,
        purchaseOrderId: po.id,
        locationId: input.locationId,
        notes: input.notes,
        receivedById: userId,
        lines: {
          create: input.lines.map((r) => {
            const line = lineById.get(r.lineId)!;
            return {
              purchaseOrderLineId: line.id,
              productId: line.productId,
              acceptedQty: received.get(r.lineId)!,
              rejectedQty: rejected.get(r.lineId)!,
              actualUnitCost: actualCost.get(r.lineId)!,
              rejectReason: r.rejectReason,
              batchNumber: r.batchNumber,
              manufactureDate: r.manufactureDate
                ? new Date(r.manufactureDate)
                : undefined,
              expiryDate: r.expiryDate ? new Date(r.expiryDate) : undefined,
            };
          }),
        },
      },
    });

    const ref = poRef(po.number);
    for (const r of input.lines) {
      const line = lineById.get(r.lineId)!;
      // The ACTUAL cost moves the average, not the quoted one — inventory is
      // worth what you paid, not what you expected to pay.
      const costAtTime = await costStockIn(
        tx,
        companyId,
        line.productId,
        received.get(r.lineId)!,
        actualCost.get(r.lineId)!
      );

      const movement = await tx.stockMovement.create({
        data: {
          companyId,
          productId: line.productId,
          locationId: input.locationId,
          type: "PURCHASE",
          quantity: received.get(r.lineId)!, // incoming: positive
          unitCost: actualCost.get(r.lineId)!,
          costAtTime,
          reference: ref,
          note: `Received against ${ref}`,
          batchNumber: r.batchNumber,
          expiryDate: r.expiryDate ? new Date(r.expiryDate) : undefined,
          createdById: userId,
        },
      });

      if (productsById.get(line.productId)?.tracksBatch) {
        await receiveIntoBatch(tx, {
          companyId,
          productId: line.productId,
          locationId: input.locationId,
          movementId: movement.id,
          batchNumber: r.batchNumber!,
          quantity: received.get(r.lineId)!,
          unitCost: actualCost.get(r.lineId)!,
          manufactureDate: r.manufactureDate ? new Date(r.manufactureDate) : null,
          expiryDate: r.expiryDate ? new Date(r.expiryDate) : null,
        });
      }
      await tx.purchaseOrderLine.update({
        where: { id: line.id },
        // Atomic `SET receivedQty = receivedQty + n` rather than writing back
        // a value we computed from a snapshot. Belt and braces alongside the
        // document lock — and the receivedQty <= quantity CHECK constraint is
        // the final backstop if either is ever bypassed.
        data: { receivedQty: { increment: received.get(r.lineId)! } },
      });
    }

    // Re-read to decide the new status honestly.
    const fresh = await tx.purchaseOrder.findFirst({
      where: { id },
      include: { lines: true },
    });
    const fullyReceived = fresh!.lines.every(
      (l) => l.receivedQty.greaterThanOrEqualTo(l.quantity)
    );

    const updated = await tx.purchaseOrder.update({
      where: { id },
      data: { status: fullyReceived ? "RECEIVED" : "PARTIAL" },
      include: poInclude,
    });

    // Existing callers read the PO off the top level, so its shape is
    // unchanged; the receipt rides alongside.
    return { ...updated, receipt };
  }, LOCKED_TX_OPTIONS);
}
