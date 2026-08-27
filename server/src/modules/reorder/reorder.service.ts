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
