/**
 * Purchase-order logic. The tricky bits live here: assigning the next
 * per-company number inside a transaction, validating that the supplier and
 * every product belong to the caller's company, and enforcing which status
 * changes are allowed.
 */
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
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
    select: { id: true, isActive: true },
  });
  if (found.length !== unique.length) {
    throw new AppError(400, "One or more products don't exist");
  }
  if (found.some((p) => !p.isActive)) {
    throw new AppError(400, "Can't order a retired product");
  }
}

export async function createPO(
  companyId: string,
  createdById: string,
  input: CreatePOInput
) {
  return prisma.$transaction(async (tx) => {
    await assertSupplier(tx, companyId, input.supplierId);
    await assertProducts(
      tx,
      companyId,
      input.lines.map((l) => l.productId)
    );

    // Next number for THIS company. The @@unique([companyId, number])
    // index is the backstop if two creates ever race.
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
        expectedDate: input.expectedDate
          ? new Date(input.expectedDate)
          : undefined,
        lines: {
          create: input.lines.map((l) => ({
            productId: l.productId,
            quantity: l.quantity,
            unitCost: l.unitCost,
          })),
        },
      },
      include: poInclude,
    });
  });
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
      (sum, l) => sum + Number(l.unitCost) * l.quantity,
      0
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
      totalCost: Math.round(totalCost * 100) / 100,
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
    if (input.lines) {
      await assertProducts(
        tx,
        companyId,
        input.lines.map((l) => l.productId)
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
                create: input.lines.map((l) => ({
                  productId: l.productId,
                  quantity: l.quantity,
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

    // Validate everything BEFORE writing anything.
    for (const r of input.lines) {
      const line = lineById.get(r.lineId);
      if (!line) throw new AppError(400, "Unknown line on this order");
      const remaining = line.quantity - line.receivedQty;
      if (r.quantity > remaining) {
        throw new AppError(
          400,
          `Can't receive ${r.quantity} — only ${remaining} left to receive for that item`
        );
      }
    }

    const ref = poRef(po.number);
    for (const r of input.lines) {
      const line = lineById.get(r.lineId)!;
      await tx.stockMovement.create({
        data: {
          companyId,
          productId: line.productId,
          locationId: input.locationId,
          type: "PURCHASE",
          quantity: r.quantity, // incoming: positive
          unitCost: line.unitCost,
          reference: ref,
          note: `Received against ${ref}`,
          createdById: userId,
        },
      });
      await tx.purchaseOrderLine.update({
        where: { id: line.id },
        data: { receivedQty: line.receivedQty + r.quantity },
      });
    }

    // Re-read to decide the new status honestly.
    const fresh = await tx.purchaseOrder.findFirst({
      where: { id },
      include: { lines: true },
    });
    const fullyReceived = fresh!.lines.every(
      (l) => l.receivedQty >= l.quantity
    );

    return tx.purchaseOrder.update({
      where: { id },
      data: { status: fullyReceived ? "RECEIVED" : "PARTIAL" },
      include: poInclude,
    });
  });
}
