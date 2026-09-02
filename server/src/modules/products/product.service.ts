/**
 * Products service — the brain for the item register.
 *
 * THE GOLDEN RULE OF THIS FILE: every single database call includes
 * companyId. Even when fetching by id. Especially when fetching by id —
 * otherwise someone could guess another company's product id and read it.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import { recordChange } from "../../lib/audit.js";
import type {
  CreateProductInput,
  UpdateProductInput,
  ListProductsQuery,
} from "./product.schemas.js";

export async function listProducts(companyId: string, q: ListProductsQuery) {
  // typed explicitly: extracted objects lose Prisma's contextual typing
  const where: Prisma.ProductWhereInput = {
    companyId, // ← the tenant stamp, always first
    ...(q.includeInactive ? {} : { isActive: true }),
    ...(q.categoryId ? { categoryId: q.categoryId } : {}),
    ...(q.search
      ? {
          OR: [
            // match name OR sku, ignoring letter case
            { name: { contains: q.search, mode: "insensitive" } },
            { sku: { contains: q.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  // one page + the total count, fetched together
  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: {
      category: { select: { id: true, name: true } },
      preferredSupplier: { select: { id: true, name: true } },
    },
      orderBy: { name: "asc" },
      take: q.take,
      skip: q.skip,
    }),
    prisma.product.count({ where }),
  ]);

  return { items, total, take: q.take, skip: q.skip };
}

export async function getProduct(companyId: string, id: string) {
  // findFirst with BOTH id and companyId — not findUnique with id alone.
  // If the product exists but belongs to someone else, we honestly
  // answer "not found" — we don't even admit it exists.
  const product = await prisma.product.findFirst({
    where: { id, companyId },
    include: {
      category: { select: { id: true, name: true } },
      preferredSupplier: { select: { id: true, name: true } },
    },
  });
  if (!product) throw new AppError(404, "Product not found");
  return product;
}

// Resolve a scanned barcode to a product (tenant-scoped). Used by the scan
// stations. 404 if no active product carries that code.
export async function getProductByBarcode(companyId: string, barcode: string) {
  const product = await prisma.product.findFirst({
    where: { companyId, barcode, isActive: true },
    include: {
      category: { select: { id: true, name: true } },
      preferredSupplier: { select: { id: true, name: true } },
    },
  });
  if (!product) throw new AppError(404, "No product found for that barcode");
  return product;
}

// Bulk import from parsed CSV rows. Validates + creates each independently,
// collecting per-row errors so one bad row doesn't sink the whole batch.
export async function importProducts(
  companyId: string,
  rows: Record<string, unknown>[]
) {
  const { importRowSchema } = await import("./product.schemas.js");
  let created = 0;
  const errors: { row: number; sku: string; message: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const parsed = importRowSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push({
        row: i + 1,
        sku: String(raw.sku ?? ""),
        message: parsed.error.issues[0]?.message ?? "Invalid row",
      });
      continue;
    }
    try {
      await createProduct(companyId, parsed.data);
      created++;
    } catch (err) {
      errors.push({
        row: i + 1,
        sku: parsed.data.sku,
        message: err instanceof AppError ? err.message : "Failed to create",
      });
    }
  }
  return { created, failed: errors.length, errors };
}

/**
 * A GST-registered company must decide every product's rate.
 *
 * WHY THIS IS CONDITIONAL RATHER THAN A PLAIN REQUIRED FIELD
 *
 * StockPilot is multi-tenant, and plenty of shops here never raise a GST
 * invoice — `taxMode` FLAT exists for exactly them, and a company with no
 * state code is already blocked from GST invoicing entirely. Forcing those
 * companies to answer a tax question that has no meaning for them wouldn't
 * make anything more correct; it would make them type a number to get past the
 * form, which puts junk in the field instead of an honest blank. A required
 * field people resent is a field full of lies.
 *
 * So the rule follows the registration: if you are set up to charge GST, every
 * product needs a decided rate. If you are not, the field stays optional.
 *
 * WHY IT RUNS ON UPDATE TOO
 *
 * Products created before this rule have no rate, and there is no way to
 * backfill one — nobody can infer a tax rate from a product name, and guessing
 * would be the exact mistake this whole change exists to stop. Enforcing on
 * edit turns every future edit into a small, natural cleanup, at the moment
 * someone already has the product open and in mind.
 *
 * `0` PASSES. Nil-rated and exempt goods are real; someone who typed 0 has
 * decided. Only "blank" is refused.
 */
async function assertGstRateDecided(
  companyId: string,
  /** Value from the request: number = set it, null = clear, undefined = leave. */
  incoming: number | null | undefined,
  /** What's already on the row, for updates. Undefined on create. */
  existing?: Prisma.Decimal | null
) {
  // undefined + an existing value = the caller isn't touching the field.
  const effective = incoming === undefined ? (existing ?? null) : incoming;
  if (effective !== null && effective !== undefined) return;

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { stateCode: true, gstin: true },
  });
  const registered = Boolean(company?.stateCode || company?.gstin);
  if (!registered) return; // not a GST business — the field means nothing here

  throw new AppError(
    400,
    "Set a GST rate for this product. Your business is registered for GST, so " +
      "every product needs a decided rate — enter 0 if these goods really are " +
      "nil-rated or exempt. Leaving it blank isn't the same thing: an invoice " +
      'would print "0%" as if you had chosen it.'
  );
}

export async function createProduct(
  companyId: string,
  input: CreateProductInput
) {
  await assertGstRateDecided(companyId, input.gstRate);

  // SKU must be unique within THIS company only
  const duplicate = await prisma.product.findFirst({
    where: { companyId, sku: input.sku },
  });
  if (duplicate) {
    throw new AppError(409, `A product with SKU "${input.sku}" already exists`);
  }

  // "" from a form's empty dropdown means "no category" → store null
  const categoryId = input.categoryId || null;

  // If a category was given, it must be OUR category — never trust ids
  // from the request without checking whose they are.
  if (categoryId) {
    const category = await prisma.category.findFirst({
      where: { id: categoryId, companyId },
    });
    if (!category) throw new AppError(400, "Unknown category");
  }

  const preferredSupplierId = input.preferredSupplierId || null;
  if (preferredSupplierId) {
    const supplier = await prisma.supplier.findFirst({
      where: { id: preferredSupplierId, companyId },
    });
    if (!supplier) throw new AppError(400, "Unknown supplier");
  }

  const barcode = input.barcode || null;
  if (barcode) {
    const dup = await prisma.product.findFirst({ where: { companyId, barcode } });
    if (dup) throw new AppError(409, `Barcode "${barcode}" is already in use`);
  }

  return prisma.product.create({
    data: { ...input, categoryId, preferredSupplierId, barcode, companyId },
    include: {
      category: { select: { id: true, name: true } },
      preferredSupplier: { select: { id: true, name: true } },
    },
  });
}

export async function updateProduct(
  companyId: string,
  id: string,
  input: UpdateProductInput,
  userId?: string
) {
  // Keep the BEFORE state — this is what makes "who changed the price from
  // ₹50 to ₹500, and when?" answerable. The row itself only shows ₹500, and
  // no amount of inference can recover what it used to be.
  const existing = await getProduct(companyId, id); // proves it exists AND is ours

  // Enforced on edit as well as create, so products predating this rule get
  // cleaned up as they're touched. See assertGstRateDecided.
  await assertGstRateDecided(companyId, input.gstRate, existing.gstRate);

  if (input.sku) {
    const duplicate = await prisma.product.findFirst({
      where: { companyId, sku: input.sku, NOT: { id } },
    });
    if (duplicate) {
      throw new AppError(409, `A product with SKU "${input.sku}" already exists`);
    }
  }

  // undefined = "don't touch category"; "" = "clear it" (store null)
  const categoryId =
    input.categoryId === undefined ? undefined : input.categoryId || null;

  if (categoryId) {
    const category = await prisma.category.findFirst({
      where: { id: categoryId, companyId },
    });
    if (!category) throw new AppError(400, "Unknown category");
  }

  const preferredSupplierId =
    input.preferredSupplierId === undefined
      ? undefined
      : input.preferredSupplierId || null;

  if (preferredSupplierId) {
    const supplier = await prisma.supplier.findFirst({
      where: { id: preferredSupplierId, companyId },
    });
    if (!supplier) throw new AppError(400, "Unknown supplier");
  }

  const barcode =
    input.barcode === undefined ? undefined : input.barcode || null;
  if (barcode) {
    const dup = await prisma.product.findFirst({
      where: { companyId, barcode, NOT: { id } },
    });
    if (dup) throw new AppError(409, `Barcode "${barcode}" is already in use`);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.product.update({
      where: { id },
      data: { ...input, categoryId, preferredSupplierId, barcode },
      include: {
        category: { select: { id: true, name: true } },
        preferredSupplier: { select: { id: true, name: true } },
      },
    });

    // Same transaction as the update, so the log can never disagree with the
    // data — see the note at the top of lib/audit.ts.
    await recordChange(tx, {
      companyId,
      userId: userId ?? null,
      action: "product.update",
      entity: "product",
      entityId: id,
      summary: `${updated.name} (${updated.sku}) updated`,
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });

    return updated;
  });
}

/**
 * Soft delete — the line through the register entry.
 * The row stays (stock history points at it!), it just stops
 * appearing in lists and can't receive new movements.
 */
export async function deactivateProduct(companyId: string, id: string) {
  await getProduct(companyId, id);
  return prisma.product.update({
    where: { id },
    data: { isActive: false },
  });
}
