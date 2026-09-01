/**
 * Sales returns (P1-6).
 *
 * WHAT WAS WRONG BEFORE
 *
 * The only way to reverse a sale was to cancel the whole invoice, which
 * restored every line in full. A customer returning 2 of 10 items had no
 * representation at all, and there was no concept of goods coming back broken
 * — so anything returned went straight into sellable stock and the shop would
 * confidently try to sell it again.
 *
 * THE RULE (PRD §9)
 *
 * "Only sellable returned stock should increase available stock."
 *
 * `condition` decides. `restock` is a decision on top of it, but a constrained
 * one: you may decline to restock good goods, you may never restock broken
 * ones. Enforced in the schema, again here, and by a CHECK constraint.
 *
 * WHEN STOCK MOVES
 *
 * At RECEIVED — not at REQUESTED. A customer *saying* they'll send something
 * back is not goods on your shelf, and treating it as such would let anyone
 * inflate stock by filing return requests.
 *
 *     REQUESTED → APPROVED → RECEIVED → REFUNDED
 *                     ↓          ↑
 *                 CANCELLED   stock moves here
 *
 * WHERE DAMAGED GOODS GO
 *
 * Nowhere, in the ledger. They're recorded on the return document with their
 * condition, but generate no stock movement, because they are not available to
 * sell. Inventing a "damaged stock" bucket now would be faking P2's inventory
 * statuses (PRD §13 warns specifically against half-implementing that), and a
 * bucket nothing can draw from is worse than an honest absence.
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
import { costReturnIn } from "../../lib/costing.js";
import { parseQuantity, formatQuantity } from "../../lib/quantity.js";
import { restoreAllocationsOf } from "../stock/batch.service.js";
import type {
  CreateReturnInput,
  UpdateReturnInput,
  ListReturnsQuery,
  RefundInput,
} from "./return.schemas.js";

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export function retRef(number: number): string {
  return `RET-${String(number).padStart(4, "0")}`;
}

const returnInclude = {
  invoice: {
    select: { id: true, number: true, customerName: true, locationId: true },
  },
  requestedBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  receivedBy: { select: { id: true, name: true } },
  lines: {
    include: {
      product: { select: { id: true, sku: true, name: true, unit: true } },
      invoiceLine: { select: { id: true, quantity: true, unitPrice: true } },
    },
  },
} as const;

/**
 * How much of each invoice line has ALREADY been returned, across every
 * non-cancelled return.
 *
 * Without this, a customer could return 10 of 10 items three times over. The
 * check has to be cumulative — looking only at the current return would miss
 * everything sent back last week.
 */
async function alreadyReturned(
  tx: Tx,
  companyId: string,
  invoiceId: string,
  excludeReturnId?: string
): Promise<Map<string, Prisma.Decimal>> {
  const lines = await tx.salesReturnLine.findMany({
    where: {
      salesReturn: {
        companyId,
        invoiceId,
        status: { not: "CANCELLED" },
        ...(excludeReturnId ? { id: { not: excludeReturnId } } : {}),
      },
    },
    select: { invoiceLineId: true, quantity: true },
  });

  const map = new Map<string, Prisma.Decimal>();
  for (const l of lines) {
    map.set(
      l.invoiceLineId,
      (map.get(l.invoiceLineId) ?? new Prisma.Decimal(0)).plus(l.quantity)
    );
  }
  return map;
}

export async function createReturn(
  companyId: string,
  userId: string,
  input: CreateReturnInput
) {
  return prisma.$transaction(async (tx) => {
    // Serialize against the invoice so two simultaneous returns can't each
    // see the same "already returned" figure and together exceed what was sold.
    await lockDocument(tx, "invoice", input.invoiceId);

    const invoice = await tx.invoice.findFirst({
      where: { id: input.invoiceId, companyId },
      include: {
        lines: {
          include: {
            product: {
              select: { id: true, name: true, unit: true, precision: true },
            },
          },
        },
      },
    });
    if (!invoice) throw new AppError(404, "Invoice not found");
    if (invoice.status === "DRAFT") {
      throw new AppError(409, "Nothing has been sold on a draft invoice yet");
    }
    if (invoice.status === "CANCELLED") {
      throw new AppError(
        409,
        "This invoice was cancelled — its stock has already been restored"
      );
    }

    const lineById = new Map(invoice.lines.map((l) => [l.id, l]));
    const prior = await alreadyReturned(tx, companyId, invoice.id);

    // Validate EVERY line before writing anything, so a bad line 3 can't
    // leave a half-built return document behind.
    const parsed = input.lines.map((l) => {
      const invLine = lineById.get(l.invoiceLineId);
      if (!invLine) {
        throw new AppError(400, "That item isn't on this invoice");
      }

      const qty = parseQuantity(l.quantity, invLine.product);
      const returnedSoFar = prior.get(l.invoiceLineId) ?? new Prisma.Decimal(0);
      const returnable = invLine.quantity.minus(returnedSoFar);

      if (qty.greaterThan(returnable)) {
        throw new AppError(
          400,
          returnedSoFar.isZero()
            ? `Only ${formatQuantity(invLine.quantity)} ${invLine.product.unit} of ${invLine.product.name} were sold`
            : `Only ${formatQuantity(returnable)} ${invLine.product.unit} of ${invLine.product.name} are left to return (${formatQuantity(returnedSoFar)} already returned)`
        );
      }

      // Belt and braces — the Zod schema refuses this too, but this is the
      // rule the whole feature exists to enforce.
      if (l.restock && l.condition !== "SELLABLE") {
        throw new AppError(
          400,
          "Only goods in sellable condition can go back into stock"
        );
      }

      return {
        invoiceLineId: l.invoiceLineId,
        productId: invLine.productId,
        quantity: qty,
        condition: l.condition,
        restock: l.restock,
        notes: l.notes,
      };
    });

    await lockCounter(tx, companyId, "sales-return");
    const last = await tx.salesReturn.findFirst({
      where: { companyId },
      orderBy: { number: "desc" },
      select: { number: true },
    });

    return tx.salesReturn.create({
      data: {
        companyId,
        number: (last?.number ?? 0) + 1,
        invoiceId: invoice.id,
        reason: input.reason,
        notes: input.notes,
        requestedById: userId,
        lines: { create: parsed },
      },
      include: returnInclude,
    });
  }, LOCKED_TX_OPTIONS);
}

export async function listReturns(companyId: string, q: ListReturnsQuery) {
  const where = {
    companyId,
    ...(q.status ? { status: q.status } : {}),
    ...(q.invoiceId ? { invoiceId: q.invoiceId } : {}),
    ...(q.number ? { number: q.number } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.salesReturn.findMany({
      where,
      orderBy: { number: "desc" },
      take: q.take,
      skip: q.skip,
      include: returnInclude,
    }),
    prisma.salesReturn.count({ where }),
  ]);

  return { items, total, take: q.take, skip: q.skip };
}

export async function getReturn(companyId: string, id: string) {
  const ret = await prisma.salesReturn.findFirst({
    where: { id, companyId },
    include: returnInclude,
  });
  if (!ret) throw new AppError(404, "Return not found");
  return ret;
}

export async function updateReturn(
  companyId: string,
  id: string,
  input: UpdateReturnInput
) {
  const existing = await prisma.salesReturn.findFirst({
    where: { id, companyId },
    select: { id: true, status: true },
  });
  if (!existing) throw new AppError(404, "Return not found");
  if (existing.status === "REFUNDED" || existing.status === "CANCELLED") {
    throw new AppError(409, "This return is closed");
  }

  return prisma.salesReturn.update({
    where: { id: existing.id },
    data: {
      reason: input.reason,
      notes: input.notes,
      refundAmount: input.refundAmount,
    },
    include: returnInclude,
  });
}

export async function approveReturn(
  companyId: string,
  userId: string,
  id: string
) {
  const ret = await prisma.salesReturn.findFirst({
    where: { id, companyId },
    select: { id: true, status: true },
  });
  if (!ret) throw new AppError(404, "Return not found");
  if (ret.status !== "REQUESTED") {
    throw new AppError(409, "Only a requested return can be approved");
  }

  return prisma.salesReturn.update({
    where: { id: ret.id },
    data: { status: "APPROVED", approvedById: userId, approvedAt: new Date() },
    include: returnInclude,
  });
}

/**
 * The goods have physically arrived — THIS is where stock moves.
 *
 * CHANGED IN P2-2. Every received line now enters the ledger; what changes
 * between them is the CONDITION they enter in.
 *
 * Before statuses existed, damaged returns were recorded on the return
 * document and then vanished — not counted, not valued, invisible to a
 * stocktake. The warehouse held goods the system denied existed, and the first
 * person to find out was whoever did the count and got an unexplainable
 * variance.
 *
 * Now the goods land in a bucket that says what they are:
 *
 *   SELLABLE + restock    → AVAILABLE   (back on sale)
 *   SELLABLE, no restock  → QUARANTINE  (came back, held pending a decision)
 *   DAMAGED               → DAMAGED     (owned, never sellable)
 *   QUARANTINE            → QUARANTINE  (awaiting inspection)
 *
 * Only AVAILABLE stock can be sold, so the business rule PRD §9 cares about —
 * damaged goods must never re-enter sellable stock — still holds exactly. The
 * difference is that the company can now see what it owns.
 */
const RETURN_STATUS: Record<string, "AVAILABLE" | "DAMAGED" | "QUARANTINE"> = {
  SELLABLE: "AVAILABLE",
  DAMAGED: "DAMAGED",
  QUARANTINE: "QUARANTINE",
};
export async function receiveReturn(
  companyId: string,
  userId: string,
  id: string
) {
  return prisma.$transaction(async (tx) => {
    await lockDocument(tx, "sales-return", id);

    const ret = await tx.salesReturn.findFirst({
      where: { id, companyId },
      include: {
        lines: true,
        invoice: { select: { id: true, number: true, locationId: true } },
      },
    });
    if (!ret) throw new AppError(404, "Return not found");
    if (ret.status !== "APPROVED") {
      throw new AppError(
        409,
        "Approve the return before recording the goods as received"
      );
    }

    // Every line comes back into the ledger now (P2-2) — the condition
    // decides which bucket, not whether it exists at all.
    const incomingLines = ret.lines;

    if (incomingLines.length > 0) {
      // Stock locks first, then cost locks — the ordering rule from P1-3.
      await lockStock(
        tx,
        companyId,
        incomingLines.map((l) => ({
          productId: l.productId,
          locationId: ret.invoice.locationId,
        }))
      );
      await lockCost(
        tx,
        companyId,
        incomingLines.map((l) => l.productId)
      );
    }

    const ref = retRef(ret.number);
    const invRef = `INV-${String(ret.invoice.number).padStart(4, "0")}`;

    for (const line of incomingLines) {
      // SELLABLE goods the operator chose NOT to restock are held rather than
      // resold — they physically came back, so pretending otherwise would be
      // the same invisibility problem in a different costume.
      const status =
        line.condition === "SELLABLE" && !line.restock
          ? "QUARANTINE"
          : RETURN_STATUS[line.condition] ?? "QUARANTINE";

      // Find the original sale so the goods come back at the cost they left
      // at — same principle as cancelInvoice. Valuing a return at a newer,
      // higher average would conjure profit out of a customer's change of mind.
      const originalSale = await tx.stockMovement.findFirst({
        where: {
          companyId,
          productId: line.productId,
          locationId: ret.invoice.locationId,
          type: "SALE",
          reference: invRef,
        },
        orderBy: { createdAt: "asc" },
      });

      const costAtTime = await costReturnIn(
        tx,
        companyId,
        line.productId,
        line.quantity,
        originalSale?.costAtTime ?? new Prisma.Decimal(0)
      );

      const movement = await tx.stockMovement.create({
        data: {
          companyId,
          productId: line.productId,
          locationId: ret.invoice.locationId,
          type: "RETURN_IN",
          quantity: line.quantity,
          status,
          costAtTime,
          reference: ref,
          note:
            status === "AVAILABLE"
              ? `Returned on ${ref} against ${invRef}`
              : `Returned ${status.toLowerCase()} on ${ref} against ${invRef}`,
          createdById: userId,
        },
      });

      // Batch-tracked goods go back to the lots they came from, so a return
      // can't launder September-expiry stock into December-expiry stock.
      //
      // ONLY for stock returning to AVAILABLE. A damaged unit must not be put
      // back into its original sellable lot — that lot is good stock, and
      // topping it up with a broken unit would make the damage sellable again
      // through the back door, which is the exact thing statuses exist to stop.
      if (originalSale && status === "AVAILABLE") {
        await restoreAllocationsOf(tx, originalSale.id, movement.id);
      }
    }

    return tx.salesReturn.update({
      where: { id: ret.id },
      data: { status: "RECEIVED", receivedById: userId, receivedAt: new Date() },
      include: returnInclude,
    });
  }, LOCKED_TX_OPTIONS);
}

/**
 * Record that the customer has been refunded.
 *
 * NOTE — deliberately a record, not a money movement. `Payment` rows are
 * positive by CHECK constraint (a refund is not a negative payment; it's a
 * different business event), and building a proper refund ledger is beyond
 * what PRD §9 asks for. This marks the decision and the amount; paying it is
 * done however the business actually pays people.
 */
export async function refundReturn(
  companyId: string,
  id: string,
  input: RefundInput
) {
  const ret = await prisma.salesReturn.findFirst({
    where: { id, companyId },
    select: { id: true, status: true },
  });
  if (!ret) throw new AppError(404, "Return not found");
  if (ret.status !== "RECEIVED") {
    throw new AppError(409, "Receive the goods before refunding");
  }

  return prisma.salesReturn.update({
    where: { id: ret.id },
    data: {
      status: "REFUNDED",
      refundAmount: input.refundAmount,
      refundedAt: new Date(),
    },
    include: returnInclude,
  });
}

/** Call off a return before the goods arrive. */
export async function cancelReturn(companyId: string, id: string) {
  const ret = await prisma.salesReturn.findFirst({
    where: { id, companyId },
    select: { id: true, status: true },
  });
  if (!ret) throw new AppError(404, "Return not found");
  if (ret.status === "RECEIVED" || ret.status === "REFUNDED") {
    throw new AppError(
      409,
      "The goods are already back — this needs an adjustment, not a cancellation"
    );
  }
  if (ret.status === "CANCELLED") {
    throw new AppError(409, "This return is already cancelled");
  }

  return prisma.salesReturn.update({
    where: { id: ret.id },
    data: { status: "CANCELLED" },
    include: returnInclude,
  });
}

/**
 * How much of each line on an invoice is still returnable — powers the
 * return form so nobody is offered a quantity that will be rejected.
 */
export async function returnableFor(companyId: string, invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, companyId },
    include: {
      lines: {
        include: {
          product: { select: { id: true, sku: true, name: true, unit: true } },
        },
      },
    },
  });
  if (!invoice) throw new AppError(404, "Invoice not found");

  const prior = await alreadyReturned(prisma, companyId, invoiceId);

  return invoice.lines.map((l) => {
    const returned = prior.get(l.id) ?? new Prisma.Decimal(0);
    return {
      invoiceLineId: l.id,
      product: l.product,
      sold: Number(l.quantity),
      returned: Number(returned),
      returnable: Number(l.quantity.minus(returned)),
      unitPrice: Number(l.unitPrice),
    };
  });
}
