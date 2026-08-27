/**
 * Invoice logic. Mirrors the purchase-order service, but the payoff action —
 * issuing — writes SALE movements (negative quantity) into the ledger, with
 * an oversell guard so you can't invoice more than you hold at the location.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import {
  lockStock,
  lockCost,
  lockCounter,
  LOCKED_TX_OPTIONS,
} from "../../lib/locks.js";
import { costStockOut, costReturnIn } from "../../lib/costing.js";
import { grandTotal, summarisePayments } from "../../lib/money.js";
import {
  planAllocation,
  consumeAllocation,
  restoreAllocationsOf,
} from "../stock/batch.service.js";
import {
  Dec,
  parseQuantity,
  formatQuantity,
  type Decimal,
} from "../../lib/quantity.js";
import type {
  CreateInvoiceInput,
  UpdateInvoiceInput,
  ListInvoiceQuery,
} from "./inv.schemas.js";

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

function invRef(number: number): string {
  return `INV-${String(number).padStart(4, "0")}`;
}

// Moved to lib/money.ts in P1-5 so payment.service can use it without an
// import cycle. Re-exported here because reports already import it from this
// module and there's no reason to churn those call sites.
export { grandTotal };

const invInclude = {
  location: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  // Payments ride along so every invoice response can carry its real balance
  // rather than making the client ask a second time (P1-5).
  payments: {
    orderBy: { paymentDate: "desc" },
    include: { createdBy: { select: { id: true, name: true } } },
  },
  lines: {
    include: {
      product: {
        select: { id: true, sku: true, name: true, unit: true, hsnCode: true },
      },
    },
  },
} as const;

async function assertLocation(tx: Tx, companyId: string, locationId: string) {
  const loc = await tx.location.findFirst({ where: { id: locationId, companyId } });
  if (!loc) throw new AppError(404, "Location not found");
}

/**
 * Confirm every product is ours and sellable, and hand back the precision
 * details so line quantities can be validated against the right product.
 */
async function assertProducts(tx: Tx, companyId: string, productIds: string[]) {
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
    throw new AppError(400, "Can't sell a retired product");
  }
  return new Map(found.map((p) => [p.id, p]));
}

/**
 * Validate every line's quantity against its own product's precision (P1-2).
 * Done up front so a 12-line invoice can't be half-written before line 9
 * turns out to be 0.5 of a product sold in whole units.
 */
function validateLineQuantities(
  lines: { productId: string; quantity: number | string }[],
  products: Map<
    string,
    { name: string; unit: string; precision: number }
  >
): Map<string, Decimal> {
  const parsed = new Map<string, Decimal>();
  lines.forEach((l, i) => {
    const product = products.get(l.productId);
    if (!product) throw new AppError(400, "One or more products don't exist");
    parsed.set(`${i}`, parseQuantity(l.quantity, product));
  });
  return parsed;
}

export async function createInvoice(
  companyId: string,
  createdById: string,
  input: CreateInvoiceInput
) {
  return prisma.$transaction(async (tx) => {
    await assertLocation(tx, companyId, input.locationId);
    const products = await assertProducts(
      tx,
      companyId,
      input.lines.map((l) => l.productId)
    );
    const quantities = validateLineQuantities(input.lines, products);

    // Serialize number assignment for this company. Without the lock, two
    // simultaneous creates both read "highest is 7" and both write 8 — the
    // unique index rejects one as an unhandled P2002 → 500.
    await lockCounter(tx, companyId, "invoice");

    const last = await tx.invoice.findFirst({
      where: { companyId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const number = (last?.number ?? 0) + 1;

    if (input.customerId) {
      const c = await tx.customer.findFirst({
        where: { id: input.customerId, companyId },
      });
      if (!c) throw new AppError(400, "Unknown customer");
    }

    return tx.invoice.create({
      data: {
        companyId,
        createdById,
        number,
        customerId: input.customerId || null,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        customerAddress: input.customerAddress,
        customerGstin: input.customerGstin,
        notes: input.notes,
        taxRate: input.taxRate ?? null,
        discount: input.discount ?? null,
        locationId: input.locationId,
        lines: {
          create: input.lines.map((l, i) => ({
            productId: l.productId,
            quantity: quantities.get(`${i}`)!, // parsed + precision-checked
            unitPrice: l.unitPrice,
          })),
        },
      },
      include: invInclude,
    });
  }, LOCKED_TX_OPTIONS);
}

export async function listInvoices(companyId: string, q: ListInvoiceQuery) {
  const where = {
    companyId,
    ...(q.status ? { status: q.status } : {}),
    ...(q.number ? { number: q.number } : {}),
    ...(q.customerId ? { customerId: q.customerId } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { number: "desc" },
      take: q.take,
      skip: q.skip,
      include: {
        location: { select: { name: true } },
        lines: { select: { quantity: true, unitPrice: true } },
      },
    }),
    prisma.invoice.count({ where }),
  ]);

  const rows = items.map((inv) => ({
    id: inv.id,
    number: inv.number,
    status: inv.status,
    customerName: inv.customerName,
    location: inv.location.name,
    issuedAt: inv.issuedAt,
    createdAt: inv.createdAt,
    itemCount: inv.lines.length,
    total: grandTotal(
      // Decimal × Decimal for the line, then out to a number once at the end.
      // Doing it the other way — Number() per line, then multiplying — is how
      // 2.5 kg × ₹33.33 quietly becomes ₹83.32499999999999.
      Number(
        inv.lines.reduce(
          (s, l) => s.plus(l.unitPrice.times(l.quantity)),
          new Dec(0)
        )
      ),
      inv.taxRate,
      inv.discount
    ),
  }));

  return { items: rows, total, take: q.take, skip: q.skip };
}

export async function getInvoice(companyId: string, id: string) {
  const inv = await prisma.invoice.findFirst({
    where: { id, companyId },
    include: invInclude,
  });
  if (!inv) throw new AppError(404, "Invoice not found");

  // The four figures PRD §8 requires, computed from the payment rows rather
  // than read off a status flag.
  const subtotal = inv.lines.reduce(
    (s, l) => s.plus(l.unitPrice.times(l.quantity)),
    new Dec(0)
  );
  const total = new Dec(
    grandTotal(Number(subtotal), inv.taxRate, inv.discount)
  );
  return { ...inv, ...summarisePayments(total, inv.payments) };
}

export async function updateInvoice(
  companyId: string,
  id: string,
  input: UpdateInvoiceInput
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.invoice.findFirst({
      where: { id, companyId },
      select: { id: true, status: true },
    });
    if (!existing) throw new AppError(404, "Invoice not found");
    if (existing.status !== "DRAFT") {
      throw new AppError(409, "Only draft invoices can be edited");
    }

    if (input.locationId) await assertLocation(tx, companyId, input.locationId);
    let quantities = new Map<string, Decimal>();
    if (input.lines) {
      const products = await assertProducts(
        tx,
        companyId,
        input.lines.map((l) => l.productId)
      );
      // Validate BEFORE deleting the old lines — otherwise a bad quantity on
      // line 4 leaves the invoice with no lines at all.
      quantities = validateLineQuantities(input.lines, products);
      await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
    }

    if (input.customerId) {
      const c = await tx.customer.findFirst({
        where: { id: input.customerId, companyId },
      });
      if (!c) throw new AppError(400, "Unknown customer");
    }

    return tx.invoice.update({
      where: { id },
      data: {
        customerId:
          input.customerId === undefined ? undefined : input.customerId || null,
        customerName: input.customerName,
        customerPhone:
          input.customerPhone === undefined ? undefined : input.customerPhone,
        customerAddress:
          input.customerAddress === undefined
            ? undefined
            : input.customerAddress,
        customerGstin:
          input.customerGstin === undefined ? undefined : input.customerGstin,
        notes: input.notes === undefined ? undefined : input.notes,
        taxRate: input.taxRate === undefined ? undefined : input.taxRate,
        discount: input.discount === undefined ? undefined : input.discount,
        locationId: input.locationId,
        ...(input.lines
          ? {
              lines: {
                create: input.lines.map((l, i) => ({
                  productId: l.productId,
                  quantity: quantities.get(`${i}`)!,
                  unitPrice: l.unitPrice,
                })),
              },
            }
          : {}),
      },
      include: invInclude,
    });
  });
}

/**
 * Issue: DRAFT → ISSUED. Deducts stock by writing a SALE movement per line
 * (negative quantity), refusing if any line would oversell its location.
 */
export async function issueInvoice(
  companyId: string,
  userId: string,
  id: string
) {
  return prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findFirst({
      where: { id, companyId },
      include: { lines: true },
    });
    if (!inv) throw new AppError(404, "Invoice not found");
    if (inv.status !== "DRAFT") {
      throw new AppError(409, "Only draft invoices can be issued");
    }

    // Lock every shelf this invoice touches BEFORE checking any of them.
    // Locking line-by-line inside the loop would leave earlier lines
    // unprotected while later ones are still being read, and two invoices
    // sharing products in different orders could deadlock. lockStock sorts.
    await lockStock(
      tx,
      companyId,
      inv.lines.map((l) => ({
        productId: l.productId,
        locationId: inv.locationId,
      }))
    );
    // Cost locks after stock locks — same order everywhere (see lib/locks.ts).
    await lockCost(
      tx,
      companyId,
      inv.lines.map((l) => l.productId)
    );

    const ref = invRef(inv.number);

    for (const line of inv.lines) {
      const product = await tx.product.findUnique({
        where: { id: line.productId },
        select: {
          name: true,
          unit: true,
          tracksBatch: true,
          batchStrategy: true,
        },
      });

      // Oversell guard: current on-hand for this product at this location.
      const sum = await tx.stockMovement.aggregate({
        where: {
          companyId,
          productId: line.productId,
          locationId: inv.locationId,
        },
        _sum: { quantity: true },
      });
      const current = sum._sum.quantity ?? new Dec(0);
      if (current.lessThan(line.quantity)) {
        throw new AppError(
          400,
          `Not enough stock of ${product?.name ?? "item"}: only ${formatQuantity(current)} ${product?.unit ?? ""} at this location`.trim()
        );
      }

      // Batch-tracked lines pick their lots by the product's strategy
      // (FEFO by default) — planned before the write so an impossible
      // allocation aborts the whole issue.
      const plan = product?.tracksBatch
        ? await planAllocation(
            tx,
            companyId,
            line.productId,
            inv.locationId,
            line.quantity,
            product.batchStrategy
          )
        : null;

      // Remove value at today's average and STAMP that average on the row.
      // This is what makes the margin on this sale permanent — a dearer
      // delivery next week cannot retroactively change what this sale cost.
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
          locationId: inv.locationId,
          type: "SALE",
          quantity: line.quantity.negated(), // outgoing
          costAtTime,
          reference: ref,
          note: `Sold on ${ref}`,
          createdById: userId,
        },
      });

      if (plan) await consumeAllocation(tx, movement.id, plan);
    }

    return tx.invoice.update({
      where: { id },
      data: { status: "ISSUED", issuedAt: new Date() },
      include: invInclude,
    });
  }, LOCKED_TX_OPTIONS);
}

/**
 * Mark an invoice paid IN FULL by recording a single payment for the balance.
 *
 * Kept because the UI and existing callers use it, but it is no longer a flag
 * flip: it now records real money, because PRD §8 forbids payment state that
 * isn't backed by payment rows. For partial payments or a specific method,
 * callers should POST /api/payments directly.
 */
export async function payInvoice(
  companyId: string,
  userId: string,
  id: string
) {
  const inv = await getInvoice(companyId, id);
  if (inv.status !== "ISSUED") {
    throw new AppError(409, "Only issued invoices can be marked paid");
  }
  if (inv.balanceAmount.lessThanOrEqualTo(0)) {
    throw new AppError(409, "This invoice is already fully paid");
  }

  const { recordPayment } = await import("../payments/payment.service.js");
  await recordPayment(companyId, userId, {
    invoiceId: id,
    amount: Number(inv.balanceAmount),
    method: "CASH",
    notes: "Marked paid in full",
  });

  return getInvoice(companyId, id);
}

/**
 * Cancel an invoice. A DRAFT just flips to CANCELLED. An ISSUED one already
 * deducted stock, so we RESTORE it: write a compensating RETURN_IN movement
 * (+qty) per line back into the same location, tagged to the invoice. PAID
 * invoices can't be cancelled (that's a refund, out of scope).
 */
export async function cancelInvoice(
  companyId: string,
  userId: string,
  id: string
) {
  return prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findFirst({
      where: { id, companyId },
      include: { lines: true },
    });
    if (!inv) throw new AppError(404, "Invoice not found");
    if (inv.status === "CANCELLED") {
      throw new AppError(409, "This invoice is already cancelled");
    }
    if (inv.status === "PAID") {
      throw new AppError(409, "Paid invoices can't be cancelled");
    }

    if (inv.status === "ISSUED") {
      // Restoring stock can't make it negative, but we take the same locks so
      // that "every ledger write for a shelf is serialized" holds without
      // exception — one rule to reason about instead of two.
      await lockStock(
        tx,
        companyId,
        inv.lines.map((l) => ({
          productId: l.productId,
          locationId: inv.locationId,
        }))
      );
      await lockCost(
        tx,
        companyId,
        inv.lines.map((l) => l.productId)
      );

      const ref = invRef(inv.number);
      for (const line of inv.lines) {
        // Find the sale we're undoing FIRST — it carries the cost these units
        // left at, and that's the value that has to come back.
        const originalSale = await tx.stockMovement.findFirst({
          where: {
            companyId,
            productId: line.productId,
            locationId: inv.locationId,
            type: "SALE",
            reference: ref,
          },
          orderBy: { createdAt: "asc" },
        });

        // Restore value at the ORIGINAL cost, not today's average. Valuing a
        // cancellation at a newer, higher average would conjure profit out of
        // undoing a sale — the books would gain money from nothing happening.
        const costAtTime = await costReturnIn(
          tx,
          companyId,
          line.productId,
          line.quantity,
          originalSale?.costAtTime ?? new Prisma.Decimal(0)
        );

        const restored = await tx.stockMovement.create({
          data: {
            companyId,
            productId: line.productId,
            locationId: inv.locationId,
            type: "RETURN_IN",
            quantity: line.quantity, // + back into stock
            costAtTime,
            reference: ref,
            note: `Invoice ${ref} cancelled — stock restored`,
            createdById: userId,
          },
        });

        // Put batch stock back into the EXACT lots it came from. Returning it
        // to "some batch" would let a cancellation quietly launder
        // September-expiry stock into December-expiry stock.
        if (originalSale) {
          await restoreAllocationsOf(tx, originalSale.id, restored.id);
        }
      }
    }

    return tx.invoice.update({
      where: { id },
      data: { status: "CANCELLED" },
      include: invInclude,
    });
  }, LOCKED_TX_OPTIONS);
}
