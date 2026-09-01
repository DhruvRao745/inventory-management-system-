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
import {
  grandTotal,
  summarisePayments,
  invoiceTotalDecimal,
} from "../../lib/money.js";
import { recordAudit } from "../../lib/audit.js";
import {
  computeInvoiceGst,
  stateCodeFromGstin,
  isValidStateCode,
} from "../../lib/gst.js";
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
import {
  availableQuantity,
  replaceReservations,
  releaseReservations,
  consumeReservations,
} from "../../lib/reservations.js";
import type {
  CreateInvoiceInput,
  UpdateInvoiceInput,
  ListInvoiceQuery,
} from "./inv.schemas.js";

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

function invRef(number: number): string {
  return `INV-${String(number).padStart(4, "0")}`;
}

/** Reservations belonging to an invoice are tagged with this source type. */
const INVOICE_SOURCE = "invoice";

/**
 * Roll the STAMPED per-line tax up into the summary a GST invoice must print.
 *
 * Reads only what is stored on the lines. It does not consult a rate table, a
 * product, or the company's current state — those may all have changed since
 * the invoice was issued, and the invoice must not change with them.
 */
function summariseStampedGst(
  lines: {
    gstRate: Decimal | null;
    taxableValue: Decimal | null;
    cgstAmount: Decimal | null;
    sgstAmount: Decimal | null;
    igstAmount: Decimal | null;
  }[],
  supplyType: string | null
) {
  const zero = new Dec(0);
  const byRate = new Map<
    string,
    {
      gstRate: Decimal;
      taxableValue: Decimal;
      cgstAmount: Decimal;
      sgstAmount: Decimal;
      igstAmount: Decimal;
    }
  >();

  let taxableValue = zero;
  let cgstAmount = zero;
  let sgstAmount = zero;
  let igstAmount = zero;

  for (const l of lines) {
    const rate = l.gstRate ?? zero;
    const t = l.taxableValue ?? zero;
    const c = l.cgstAmount ?? zero;
    const s = l.sgstAmount ?? zero;
    const i = l.igstAmount ?? zero;

    taxableValue = taxableValue.plus(t);
    cgstAmount = cgstAmount.plus(c);
    sgstAmount = sgstAmount.plus(s);
    igstAmount = igstAmount.plus(i);

    const key = rate.toString();
    const row = byRate.get(key) ?? {
      gstRate: rate,
      taxableValue: zero,
      cgstAmount: zero,
      sgstAmount: zero,
      igstAmount: zero,
    };
    byRate.set(key, {
      gstRate: rate,
      taxableValue: row.taxableValue.plus(t),
      cgstAmount: row.cgstAmount.plus(c),
      sgstAmount: row.sgstAmount.plus(s),
      igstAmount: row.igstAmount.plus(i),
    });
  }

  return {
    supplyType,
    taxableValue,
    cgstAmount,
    sgstAmount,
    igstAmount,
    totalTax: cgstAmount.plus(sgstAmount).plus(igstAmount),
    byRate: [...byRate.values()].sort((a, b) => a.gstRate.comparedTo(b.gstRate)),
  };
}

/**
 * Work out the place of supply for an invoice (P2-3).
 *
 * Order of preference, most specific first:
 *   1. what the caller explicitly said
 *   2. the linked customer's state
 *   3. the state embedded in the buyer's GSTIN (first two digits)
 *   4. the seller's own state — the walk-in customer at the counter
 *
 * Step 3 matters because a buyer who hands over a GSTIN has already told you
 * their state; asking for it separately just invites the two to disagree.
 */
async function resolvePlaceOfSupply(
  tx: Tx,
  companyId: string,
  input: {
    placeOfSupply?: string;
    customerId?: string | null;
    customerGstin?: string | null;
  },
  sellerStateCode: string | null
): Promise<string | null> {
  if (input.placeOfSupply) return input.placeOfSupply;

  if (input.customerId) {
    const c = await tx.customer.findFirst({
      where: { id: input.customerId, companyId },
      select: { stateCode: true, gstin: true },
    });
    if (c?.stateCode) return c.stateCode;
    const fromCustomerGstin = stateCodeFromGstin(c?.gstin);
    if (fromCustomerGstin) return fromCustomerGstin;
  }

  const fromGstin = stateCodeFromGstin(input.customerGstin);
  if (fromGstin) return fromGstin;

  return sellerStateCode;
}

/**
 * Compute and stamp GST onto an invoice's lines (P2-3).
 *
 * Called when a GST invoice is created or edited. The numbers it writes are
 * SNAPSHOTS — from this point the invoice carries its own tax and no later
 * change to a product's rate, a customer's address, or the company's state can
 * alter it. That is what makes an issued invoice a stable legal document
 * rather than a view over today's configuration.
 */
async function stampGst(
  tx: Tx,
  companyId: string,
  invoiceId: string
): Promise<void> {
  const inv = await tx.invoice.findFirst({
    where: { id: invoiceId, companyId },
    include: { lines: true },
  });
  if (!inv || inv.taxMode !== "GST") return;

  const company = await tx.company.findUnique({
    where: { id: companyId },
    select: { stateCode: true },
  });

  const products = await tx.product.findMany({
    where: { id: { in: inv.lines.map((l) => l.productId) }, companyId },
    select: { id: true, gstRate: true, hsnCode: true },
  });
  const productById = new Map(products.map((p) => [p.id, p]));

  const breakup = computeInvoiceGst({
    lines: inv.lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      // A rate already stamped on the line wins — that's the per-line
      // override. Otherwise take the product's current rate.
      gstRate: l.gstRate ?? productById.get(l.productId)?.gstRate ?? null,
    })),
    discount: inv.discount,
    sellerStateCode: company?.stateCode ?? null,
    placeOfSupply: inv.placeOfSupply,
  });

  await Promise.all(
    inv.lines.map((line, i) => {
      const tax = breakup.lines[i]!;
      return tx.invoiceLine.update({
        where: { id: line.id },
        data: {
          hsnCode: line.hsnCode ?? productById.get(line.productId)?.hsnCode ?? null,
          gstRate: tax.gstRate,
          taxableValue: tax.taxableValue,
          cgstAmount: tax.cgstAmount,
          sgstAmount: tax.sgstAmount,
          igstAmount: tax.igstAmount,
        },
      });
    })
  );

  await tx.invoice.update({
    where: { id: invoiceId },
    data: { supplyType: breakup.supplyType },
  });
}

/**
 * Put (or re-put) a DRAFT invoice's hold on the shelf (P2-1).
 *
 * Only drafts reserve. Once issued the goods have physically left, recorded as
 * SALE movements — a hold on top of that would subtract the same units twice,
 * once as a promise and again as a fact.
 *
 * DRAFTING IS NEVER BLOCKED — the deliberate decision here.
 *
 * A draft reserves as much as the shelf can currently back, and no more. It
 * does NOT refuse to exist when stock is short, because a draft is not a
 * promise to the customer yet; it's work in progress. Refusing it would break
 * the ordinary case of writing up an order before the delivery that fills it
 * has arrived.
 *
 * That costs nothing in safety, because the real gate is elsewhere: ISSUING
 * re-checks availability in full and refuses if the stock still isn't there.
 * So a draft can be optimistic, but nothing can ever be SOLD that doesn't
 * exist. Reserving partially also keeps the formula exactly true — reserved
 * never exceeds on hand, so `available` can never be driven negative by a
 * promise.
 *
 * The caller must already hold the stock locks for every line.
 */
async function reserveForInvoice(
  tx: Tx,
  companyId: string,
  userId: string,
  invoice: {
    id: string;
    status: string;
    locationId: string;
    lines: { productId: string; quantity: Decimal }[];
  }
): Promise<void> {
  if (invoice.status !== "DRAFT") return;

  // Several lines may name the same product — one shelf, one hold.
  const wanted = new Map<string, Decimal>();
  for (const line of invoice.lines) {
    wanted.set(
      line.productId,
      (wanted.get(line.productId) ?? new Dec(0)).plus(line.quantity)
    );
  }

  const holds: {
    productId: string;
    locationId: string;
    quantity: Decimal;
  }[] = [];

  for (const [productId, quantity] of wanted) {
    // Ignore this invoice's OWN existing hold when asking what's free —
    // otherwise editing a draft competes with the copy of itself it is about
    // to replace, and a no-op save could fail on a tight shelf.
    const { available } = await availableQuantity(
      tx,
      companyId,
      { productId, locationId: invoice.locationId },
      { excludeSource: { sourceType: INVOICE_SOURCE, sourceId: invoice.id } }
    );

    // Hold the smaller of "what this invoice wants" and "what's actually
    // there". Never negative: an empty shelf holds nothing rather than
    // reserving a debt.
    const hold = Dec.max(new Dec(0), Dec.min(quantity, available));
    if (hold.greaterThan(0)) {
      holds.push({ productId, locationId: invoice.locationId, quantity: hold });
    }
  }

  await replaceReservations(
    tx,
    companyId,
    userId,
    { sourceType: INVOICE_SOURCE, sourceId: invoice.id },
    holds
  );
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

    // A draft holds its stock (P2-1). Lock every shelf BEFORE checking
    // availability — reserving is a read-check-write, exactly the race the
    // ledger locks exist for, and it uses the same key so a reservation and a
    // sale queue behind each other rather than passing in the night.
    await lockStock(
      tx,
      companyId,
      input.lines.map((l) => ({
        productId: l.productId,
        locationId: input.locationId,
      }))
    );

    // GST is opt-in per invoice (P2-3). A company with no state code cannot
    // have GST computed at all — there is no way to tell an intra-state sale
    // from an inter-state one, and guessing would put money in the wrong
    // government's column.
    const company = await tx.company.findUnique({
      where: { id: companyId },
      select: { stateCode: true },
    });
    if (input.useGst && !isValidStateCode(company?.stateCode)) {
      throw new AppError(
        400,
        "Set your business state before raising GST invoices — it decides CGST/SGST vs IGST"
      );
    }

    const placeOfSupply = input.useGst
      ? await resolvePlaceOfSupply(
          tx,
          companyId,
          input,
          company?.stateCode ?? null
        )
      : null;

    const invoice = await tx.invoice.create({
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
        taxMode: input.useGst ? "GST" : "FLAT",
        placeOfSupply,
        locationId: input.locationId,
        lines: {
          create: input.lines.map((l, i) => ({
            productId: l.productId,
            quantity: quantities.get(`${i}`)!, // parsed + precision-checked
            unitPrice: l.unitPrice,
            gstRate: l.gstRate ?? null, // per-line override, if given
          })),
        },
      },
      include: invInclude,
    });

    await stampGst(tx, companyId, invoice.id);
    await reserveForInvoice(tx, companyId, createdById, invoice);

    // Re-read so the caller gets the stamped tax rather than the pre-stamp
    // snapshot — otherwise the response shows nulls for tax that was, in fact,
    // computed and saved a moment ago.
    return tx.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
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
    // Routed by taxMode (P2-3): a GST invoice sums the tax STAMPED on its
    // lines; a legacy FLAT one uses its stored whole-invoice rate. Neither is
    // recomputed from today's rates — an issued invoice's total must never
    // move because a rate changed afterwards.
    //
    // Still Decimal throughout, out to a number once at the end. The other way
    // round — Number() per line, then multiplying — is how 2.5 kg × ₹33.33
    // quietly becomes ₹83.32499999999999.
    total: Number(invoiceTotalDecimal(inv)),
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
  const total = invoiceTotalDecimal(inv);

  // A GST invoice also carries its tax breakdown — the per-rate summary a GST
  // invoice is legally required to print. Built from the STAMPED line amounts,
  // never recomputed, for the reason given on invoiceTotalDecimal.
  const gst =
    inv.taxMode === "GST"
      ? summariseStampedGst(inv.lines, inv.supplyType)
      : null;

  return { ...inv, subtotal, gst, ...summarisePayments(total, inv.payments) };
}

export async function updateInvoice(
  companyId: string,
  id: string,
  input: UpdateInvoiceInput
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.invoice.findFirst({
      where: { id, companyId },
      select: {
        id: true,
        status: true,
        locationId: true,
        createdById: true,
        lines: { select: { productId: true } },
      },
    });
    if (!existing) throw new AppError(404, "Invoice not found");
    if (existing.status !== "DRAFT") {
      throw new AppError(409, "Only draft invoices can be edited");
    }

    if (input.locationId) await assertLocation(tx, companyId, input.locationId);

    // Lock the OLD shelves and the NEW ones together, before touching either
    // (P2-1). An edit can move an invoice to a different location or swap its
    // products, so the hold is released from one shelf and taken on another —
    // both sides have to be held still for that to be atomic. lockStock sorts
    // the keys, so this can't deadlock against a concurrent edit going the
    // other way.
    const newLocationId = input.locationId ?? existing.locationId;
    await lockStock(tx, companyId, [
      ...existing.lines.map((l) => ({
        productId: l.productId,
        locationId: existing.locationId,
      })),
      ...(input.lines ?? []).map((l) => ({
        productId: l.productId,
        locationId: newLocationId,
      })),
    ]);
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

    const updated = await tx.invoice.update({
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
        // GST settings on a DRAFT (P2-3). These have to be written BEFORE
        // stampGst runs below, because stampGst reads the invoice back from
        // the database — it recomputes from what is stored, not from `input`.
        // Missing them meant the tax was re-stamped against the invoice's
        // original place of supply, so re-pointing a sale at another state
        // silently kept charging CGST/SGST instead of IGST.
        ...(input.useGst === undefined
          ? {}
          : { taxMode: input.useGst ? ("GST" as const) : ("FLAT" as const) }),
        ...(input.placeOfSupply === undefined
          ? {}
          : { placeOfSupply: input.placeOfSupply }),
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

    // Re-stamp the tax to match the new lines (P2-3). Editing a DRAFT is the
    // only time this is allowed to happen — the invoice hasn't been issued, so
    // nothing has been sent to a customer and no legal record is being
    // rewritten. Once issued, the stamped figures are frozen for good.
    await stampGst(tx, companyId, id);

    // Re-place the hold to match what the invoice now says. This is a REPLACE,
    // not an adjustment — the invoice's claim is whatever its current lines
    // are, and deriving that from a delta would drift the moment anything else
    // touched the row.
    await reserveForInvoice(tx, companyId, existing.createdById, updated);

    return tx.invoice.findUniqueOrThrow({
      where: { id },
      include: invInclude,
    });
  }, LOCKED_TX_OPTIONS);
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

      // Oversell guard, now against AVAILABLE — but ignoring this invoice's
      // OWN hold (P2-1).
      //
      // This exclusion is the crux of the whole feature. A draft reserves its
      // lines, so at issue time the stock it needs is already spoken for by
      // itself. Count that against it and every draft blocks its own issue:
      // reserve 5, then be told 5 are unavailable, forever. Excluding only
      // this invoice's reservation means it can take exactly what it set
      // aside, while everyone ELSE's holds still protect them from it.
      const { onHand, reserved, available } = await availableQuantity(
        tx,
        companyId,
        { productId: line.productId, locationId: inv.locationId },
        { excludeSource: { sourceType: INVOICE_SOURCE, sourceId: inv.id } }
      );
      if (available.lessThan(line.quantity)) {
        const other = reserved.greaterThan(0)
          ? ` (${formatQuantity(onHand)} on hand, ${formatQuantity(reserved)} reserved elsewhere)`
          : "";
        throw new AppError(
          400,
          `Not enough stock of ${product?.name ?? "item"}: only ${formatQuantity(available)} ${product?.unit ?? ""} available at this location${other}`.trim()
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

    // The promise became a fact. Mark the holds CONSUMED rather than releasing
    // them: released would suggest the stock was let go, when it actually left
    // as a sale. Either way they stop counting against availability — but only
    // one of them is true, and the reservation history is read by humans.
    await consumeReservations(tx, companyId, {
      sourceType: INVOICE_SOURCE,
      sourceId: id,
    });

    await recordAudit(tx, {
      companyId,
      userId,
      action: "invoice.issue",
      entity: "invoice",
      entityId: id,
      summary: `${ref} issued — stock deducted`,
      before: { status: "DRAFT" },
      after: { status: "ISSUED" },
    });

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

    // Cancelling a DRAFT never touched the ledger, but it WAS holding stock —
    // let it go, or a cancelled draft would keep goods off the shelf forever
    // with nothing left to explain why (P2-1). Harmless on an issued invoice:
    // its holds were consumed at issue, so there is nothing ACTIVE to release.
    await releaseReservations(tx, companyId, {
      sourceType: INVOICE_SOURCE,
      sourceId: id,
    });

    await recordAudit(tx, {
      companyId,
      userId,
      action: "invoice.cancel",
      entity: "invoice",
      entityId: id,
      summary: `${invRef(inv.number)} cancelled${inv.status === "ISSUED" ? " — stock restored" : ""}`,
      before: { status: inv.status },
      after: { status: "CANCELLED" },
    });

    return tx.invoice.update({
      where: { id },
      data: { status: "CANCELLED" },
      include: invInclude,
    });
  }, LOCKED_TX_OPTIONS);
}
