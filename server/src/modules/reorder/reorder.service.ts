/**
 * Location-aware reordering (P1-8).
 *
 * WHAT WAS WRONG (PRD §11)
 *
 * The reorder report summed stock across every location, then compared the
 * total against one company-wide threshold:
 *
 *     Warehouse A: 2 units    Warehouse B: 100 units    threshold: 10
 *     → total 102 → "plenty of stock" → no warning
 *
 * Meanwhile Warehouse A is empty and the staff there have nothing to sell. A
 * company total tells you nothing about the shelf someone is standing at.
 *
 * THE FIX
 *
 * Reorder is evaluated per (product, location). `ProductLocationSetting` holds
 * the rules for a specific shelf; every field is optional and falls back to
 * the product-level default, so nothing changes for anyone who hasn't set one.
 *
 * HOW MUCH TO ORDER
 *
 * In priority order:
 *   1. `reorderQuantity` — a fixed size, for suppliers who sell by the pallet.
 *   2. `maxQuantity − onHand` — top the shelf back up to full.
 *   3. `2 × min − onHand` — the old heuristic, when nothing better is known.
 *
 * Never less than one unit: suggesting "order 0.4" helps nobody.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import type { UpsertSettingInput } from "./reorder.schemas.js";

const D = Prisma.Decimal;

export type ReorderRow = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  locationId: string;
  locationName: string;
  onHand: number;
  minQuantity: number;
  maxQuantity: number | null;
  suggestedQty: number;
  /** True when this shelf's rule came from a per-location setting. */
  locationSpecific: boolean;
  costPrice: string;
  preferredSupplier: { id: string; name: string } | null;
};

/**
 * What to reorder, shelf by shelf.
 *
 * A product can appear more than once — one row per location that's short,
 * because "Warehouse A needs 8" and "Shop needs 3" are two different jobs.
 */
export async function reorderReport(
  companyId: string,
  filters: { locationId?: string } = {}
): Promise<ReorderRow[]> {
  const [products, locations, settings, grouped] = await Promise.all([
    prisma.product.findMany({
      where: { companyId, isActive: true },
      include: { preferredSupplier: { select: { id: true, name: true } } },
    }),
    prisma.location.findMany({
      where: {
        companyId,
        ...(filters.locationId ? { id: filters.locationId } : {}),
      },
      select: { id: true, name: true },
    }),
    prisma.productLocationSetting.findMany({
      where: {
        companyId,
        ...(filters.locationId ? { locationId: filters.locationId } : {}),
      },
      include: { preferredSupplier: { select: { id: true, name: true } } },
    }),
    // Per (product, LOCATION) — the whole point of this feature.
    prisma.stockMovement.groupBy({
      by: ["productId", "locationId"],
      where: {
        companyId,
        ...(filters.locationId ? { locationId: filters.locationId } : {}),
      },
      _sum: { quantity: true },
    }),
  ]);

  const productById = new Map(products.map((p) => [p.id, p]));
  const onHandByKey = new Map(
    grouped.map((g) => [
      `${g.productId}:${g.locationId}`,
      g._sum.quantity ?? new D(0),
    ])
  );
  const settingByKey = new Map(
    settings.map((s) => [`${s.productId}:${s.locationId}`, s])
  );

  const rows: ReorderRow[] = [];

  for (const product of products) {
    for (const location of locations) {
      const key = `${product.id}:${location.id}`;
      const setting = settingByKey.get(key);

      // The effective minimum for THIS shelf.
      const min = setting?.minQuantity ?? product.lowStockThreshold;
      // A zero minimum means "don't track this here" — otherwise every
      // product at every location would appear the moment it hit zero,
      // burying the shelves that genuinely need attention.
      if (min.lessThanOrEqualTo(0)) continue;

      const onHand = onHandByKey.get(key) ?? new D(0);
      if (onHand.greaterThan(min)) continue; // this shelf is fine

      const max = setting?.maxQuantity ?? null;
      const suggested = setting?.reorderQuantity
        ? setting.reorderQuantity
        : max
          ? max.minus(onHand)
          : min.times(2).minus(onHand);

      rows.push({
        productId: product.id,
        sku: product.sku,
        name: product.name,
        unit: product.unit,
        locationId: location.id,
        locationName: location.name,
        onHand: Number(onHand),
        minQuantity: Number(min),
        maxQuantity: max ? Number(max) : null,
        suggestedQty: Number(
          Prisma.Decimal.max(new D(1), suggested).toDecimalPlaces(4)
        ),
        locationSpecific: Boolean(setting?.minQuantity),
        costPrice: product.costPrice.toString(),
        // A northern warehouse may buy from a different local supplier than
        // a southern one, so the location's choice wins where it's set.
        preferredSupplier:
          setting?.preferredSupplier ?? product.preferredSupplier ?? null,
      });
    }
  }

  // Emptiest shelves first — the ones closest to letting a customer down.
  return rows.sort((a, b) => a.onHand - a.minQuantity - (b.onHand - b.minQuantity));
}

/** Every per-location rule, for the settings screen. */
export async function listSettings(
  companyId: string,
  filters: { productId?: string; locationId?: string } = {}
) {
  return prisma.productLocationSetting.findMany({
    where: {
      companyId,
      ...(filters.productId ? { productId: filters.productId } : {}),
      ...(filters.locationId ? { locationId: filters.locationId } : {}),
    },
    include: {
      product: { select: { id: true, sku: true, name: true, unit: true } },
      location: { select: { id: true, name: true } },
      preferredSupplier: { select: { id: true, name: true } },
    },
    orderBy: [{ product: { name: "asc" } }, { location: { name: "asc" } }],
  });
}

/**
 * Create or update the rule for one shelf.
 *
 * Upsert rather than separate create/update: there is exactly one rule per
 * (product, location) by unique constraint, so "set the rule for this shelf"
 * is one idea, not two.
 */
export async function upsertSetting(
  companyId: string,
  input: UpsertSettingInput
) {
  const [product, location] = await Promise.all([
    prisma.product.findFirst({
      where: { id: input.productId, companyId },
      select: { id: true },
    }),
    prisma.location.findFirst({
      where: { id: input.locationId, companyId },
      select: { id: true },
    }),
  ]);
  if (!product) throw new AppError(404, "Product not found");
  if (!location) throw new AppError(404, "Location not found");

  if (input.preferredSupplierId) {
    const supplier = await prisma.supplier.findFirst({
      where: { id: input.preferredSupplierId, companyId },
      select: { id: true },
    });
    if (!supplier) throw new AppError(404, "Supplier not found");
  }

  // A maximum below the minimum would ask for a negative order — nonsense
  // that would otherwise surface as a mystifying suggestion of "1".
  if (
    input.minQuantity !== undefined &&
    input.maxQuantity !== undefined &&
    input.maxQuantity < input.minQuantity
  ) {
    throw new AppError(
      400,
      "Maximum stock can't be below the minimum for this location"
    );
  }

  const data = {
    minQuantity: input.minQuantity ?? null,
    maxQuantity: input.maxQuantity ?? null,
    reorderQuantity: input.reorderQuantity ?? null,
    preferredSupplierId: input.preferredSupplierId ?? null,
  };

  return prisma.productLocationSetting.upsert({
    where: {
      companyId_productId_locationId: {
        companyId,
        productId: input.productId,
        locationId: input.locationId,
      },
    },
    create: {
      companyId,
      productId: input.productId,
      locationId: input.locationId,
      ...data,
    },
    update: data,
    include: {
      product: { select: { id: true, sku: true, name: true, unit: true } },
      location: { select: { id: true, name: true } },
      preferredSupplier: { select: { id: true, name: true } },
    },
  });
}

/** Remove a shelf's rule — it falls back to the product default. */
export async function deleteSetting(companyId: string, id: string) {
  const existing = await prisma.productLocationSetting.findFirst({
    where: { id, companyId },
    select: { id: true },
  });
  if (!existing) throw new AppError(404, "Setting not found");
  await prisma.productLocationSetting.delete({ where: { id: existing.id } });
}

/* ==================================================================== *
 * P3-1 — turning recommendations into draft purchase orders            *
 * ==================================================================== */

/**
 * Generate DRAFT purchase orders from the reorder report.
 *
 * WHAT THIS IS AND ISN'T
 *
 * It is a clerical shortcut: the report already knows what is short, how much
 * to order and from whom, and re-typing that into a purchase order is work a
 * machine should do.
 *
 * It is NOT automatic ordering. Every order it creates is a DRAFT, and a draft
 * reaches a supplier only when a human moves it to ORDERED — the same
 * transition that has always existed. Nothing here can place an order, and
 * that is a structural property rather than a rule someone has to remember:
 * this function has no way to set any status but DRAFT.
 *
 * WHY IT PRODUCES SEVERAL ORDERS
 *
 * A purchase order goes to ONE supplier. A reorder report spans many. Twelve
 * short shelves across three suppliers is three orders, not one — grouping is
 * not a convenience here, it is what makes the output valid.
 *
 * LINES WITH NO SUPPLIER ARE REFUSED, NOT GUESSED
 *
 * A product with no preferred supplier cannot be ordered, and picking one for
 * the user would be inventing a commercial relationship. Those rows come back
 * in `skipped` with a reason, so the gap is visible and fixable rather than
 * silently dropped.
 *
 * QUANTITIES ACROSS LOCATIONS ARE SUMMED
 *
 * The report is per shelf ("Warehouse A needs 8, Shop needs 3") because that
 * is how you restock. But you order from a supplier once, for 11. Where the
 * goods then go is a receiving decision, made when they arrive.
 */
export type GeneratedPO = {
  purchaseOrderId: string;
  number: number;
  supplier: { id: string; name: string };
  lineCount: number;
  totalCost: number;
};

export type SkippedRecommendation = {
  productId: string;
  sku: string;
  name: string;
  reason: string;
};

export async function generateDraftPOs(
  companyId: string,
  userId: string,
  options: { locationId?: string; productIds?: string[] } = {}
): Promise<{ created: GeneratedPO[]; skipped: SkippedRecommendation[] }> {
  const rows = await reorderReport(companyId, {
    locationId: options.locationId,
  } as never);

  const wanted = options.productIds?.length
    ? rows.filter((r) => options.productIds!.includes(r.productId))
    : rows;

  const skipped: SkippedRecommendation[] = [];

  // supplierId → productId → line
  const bySupplier = new Map<
    string,
    {
      supplierName: string;
      lines: Map<
        string,
        { productId: string; quantity: number; unitCost: number }
      >;
    }
  >();

  for (const row of wanted) {
    if (!row.preferredSupplier) {
      skipped.push({
        productId: row.productId,
        sku: row.sku,
        name: row.name,
        reason: "No preferred supplier set",
      });
      continue;
    }
    if (row.suggestedQty <= 0) {
      // Defensive: the report shouldn't produce these, but a zero-quantity
      // line would fail validation deeper in and produce a confusing error.
      skipped.push({
        productId: row.productId,
        sku: row.sku,
        name: row.name,
        reason: "Nothing to order",
      });
      continue;
    }

    const group = bySupplier.get(row.preferredSupplier.id) ?? {
      supplierName: row.preferredSupplier.name,
      lines: new Map(),
    };

    // Same product short at two locations → one line for the total.
    const existing = group.lines.get(row.productId);
    group.lines.set(row.productId, {
      productId: row.productId,
      quantity: (existing?.quantity ?? 0) + row.suggestedQty,
      // costPrice is the reference purchase price — the right starting point
      // for an order someone is about to review. avgCost would be wrong here:
      // it is what stock HAS cost, not what the supplier will charge.
      unitCost: Number(row.costPrice),
    });
    bySupplier.set(row.preferredSupplier.id, group);
  }

  const { createPO } = await import("../purchase-orders/po.service.js");
  const created: GeneratedPO[] = [];

  for (const [supplierId, group] of bySupplier) {
    const lines = [...group.lines.values()];

    // One PO per supplier, each created through the ORDINARY path — number
    // locking, precision checks and ownership assertions all apply. Nothing
    // here writes a purchase order directly.
    const po = await createPO(
      companyId,
      userId,
      {
        supplierId,
        notes: "Generated from the reorder report — review before ordering.",
        lines: lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          unitCost: l.unitCost,
        })),
      } as Parameters<typeof createPO>[2],
      "reorder"
    );

    created.push({
      purchaseOrderId: po.id,
      number: po.number,
      supplier: { id: supplierId, name: group.supplierName },
      lineCount: lines.length,
      totalCost:
        Math.round(
          lines.reduce((s, l) => s + l.quantity * l.unitCost, 0) * 100
        ) / 100,
    });
  }

  return { created, skipped };
}
