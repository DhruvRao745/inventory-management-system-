/**
 * Invoice logic. Mirrors the purchase-order service, but the payoff action —
 * issuing — writes SALE movements (negative quantity) into the ledger, with
 * an oversell guard so you can't invoice more than you hold at the location.
 */
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import type {
  CreateInvoiceInput,
  UpdateInvoiceInput,
  ListInvoiceQuery,
} from "./inv.schemas.js";

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

function invRef(number: number): string {
  return `INV-${String(number).padStart(4, "0")}`;
}

// Grand total = (subtotal − discount) + tax on that amount.
export function grandTotal(
  subtotal: number,
  taxRate: unknown,
  discount: unknown
): number {
  const disc = Number(discount ?? 0);
  const taxable = Math.max(0, subtotal - disc);
  const tax = taxable * (Number(taxRate ?? 0) / 100);
  return Math.round((taxable + tax) * 100) / 100;
}

const invInclude = {
  location: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  lines: {
    include: {
      product: { select: { id: true, sku: true, name: true, unit: true } },
    },
  },
} as const;

async function assertLocation(tx: Tx, companyId: string, locationId: string) {
  const loc = await tx.location.findFirst({ where: { id: locationId, companyId } });
  if (!loc) throw new AppError(404, "Location not found");
}

async function assertProducts(tx: Tx, companyId: string, productIds: string[]) {
  const unique = [...new Set(productIds)];
  const found = await tx.product.findMany({
    where: { id: { in: unique }, companyId },
    select: { id: true, isActive: true },
  });
  if (found.length !== unique.length) {
    throw new AppError(400, "One or more products don't exist");
  }
  if (found.some((p) => !p.isActive)) {
    throw new AppError(400, "Can't sell a retired product");
  }
}

export async function createInvoice(
  companyId: string,
  createdById: string,
  input: CreateInvoiceInput
) {
  return prisma.$transaction(async (tx) => {
    await assertLocation(tx, companyId, input.locationId);
    await assertProducts(
      tx,
      companyId,
      input.lines.map((l) => l.productId)
    );

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
        notes: input.notes,
        taxRate: input.taxRate ?? null,
        discount: input.discount ?? null,
        locationId: input.locationId,
        lines: {
          create: input.lines.map((l) => ({
            productId: l.productId,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
          })),
        },
      },
      include: invInclude,
    });
  });
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
      inv.lines.reduce((s, l) => s + Number(l.unitPrice) * l.quantity, 0),
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
  return inv;
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
    if (input.lines) {
      await assertProducts(
        tx,
        companyId,
        input.lines.map((l) => l.productId)
      );
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
        notes: input.notes === undefined ? undefined : input.notes,
        taxRate: input.taxRate === undefined ? undefined : input.taxRate,
        discount: input.discount === undefined ? undefined : input.discount,
        locationId: input.locationId,
        ...(input.lines
          ? {
              lines: {
                create: input.lines.map((l) => ({
                  productId: l.productId,
                  quantity: l.quantity,
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

    const ref = invRef(inv.number);

    for (const line of inv.lines) {
      // Oversell guard: current on-hand for this product at this location.
      const sum = await tx.stockMovement.aggregate({
        where: {
          companyId,
          productId: line.productId,
          locationId: inv.locationId,
        },
        _sum: { quantity: true },
      });
      const current = sum._sum.quantity ?? 0;
      if (current - line.quantity < 0) {
        const p = await tx.product.findUnique({
          where: { id: line.productId },
          select: { name: true },
        });
        throw new AppError(
          400,
          `Not enough stock of ${p?.name ?? "item"}: only ${current} at this location`
        );
      }

      await tx.stockMovement.create({
        data: {
          companyId,
          productId: line.productId,
          locationId: inv.locationId,
          type: "SALE",
          quantity: -line.quantity, // outgoing
          reference: ref,
          note: `Sold on ${ref}`,
          createdById: userId,
        },
      });
    }

    return tx.invoice.update({
      where: { id },
      data: { status: "ISSUED", issuedAt: new Date() },
      include: invInclude,
    });
  });
}

export async function payInvoice(companyId: string, id: string) {
  const inv = await prisma.invoice.findFirst({
    where: { id, companyId },
    select: { id: true, status: true },
  });
  if (!inv) throw new AppError(404, "Invoice not found");
  if (inv.status !== "ISSUED") {
    throw new AppError(409, "Only issued invoices can be marked paid");
  }
  return prisma.invoice.update({
    where: { id },
    data: { status: "PAID" },
    include: invInclude,
  });
}

export async function cancelInvoice(companyId: string, id: string) {
  const inv = await prisma.invoice.findFirst({
    where: { id, companyId },
    select: { id: true, status: true },
  });
  if (!inv) throw new AppError(404, "Invoice not found");
  if (inv.status !== "DRAFT") {
    throw new AppError(
      409,
      "Only draft invoices can be cancelled (issued ones have moved stock)"
    );
  }
  return prisma.invoice.update({
    where: { id },
    data: { status: "CANCELLED" },
    include: invInclude,
  });
}
