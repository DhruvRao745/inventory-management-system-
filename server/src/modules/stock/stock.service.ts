/**
 * Stock service — the diary keeper. The most important file in the app.
 *
 * Rules it enforces:
 * 1. Signs are decided HERE, never by the client
 * 2. Stock can never go below zero
 * 3. Transfers are two lines born together (transaction)
 * 4. Diary lines are only ever ADDED — no update, no delete, anywhere
 */
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error.js";
import type {
  CreateMovementInput,
  TransferInput,
  ListMovementsQuery,
  LevelsQuery,
} from "./stock.schemas.js";

// Which way does each type move the stock?
const DIRECTION: Record<CreateMovementInput["type"], 1 | -1> = {
  PURCHASE: 1,
  RETURN_IN: 1,
  SALE: -1,
  RETURN_OUT: -1,
  ADJUSTMENT: 1, // adjustment quantity arrives already signed
};

/** "How many are there right now?" = sum of all diary lines. */
export async function getStockLevel(
  companyId: string,
  productId: string,
  locationId: string
): Promise<number> {
  const result = await prisma.stockMovement.aggregate({
    where: { companyId, productId, locationId },
    _sum: { quantity: true },
  });
  return result._sum.quantity ?? 0;
}

/** Check the product and location really belong to this company. */
async function assertOwnership(
  companyId: string,
  productId: string,
  locationId: string
) {
  const [product, location] = await Promise.all([
    prisma.product.findFirst({ where: { id: productId, companyId } }),
    prisma.location.findFirst({ where: { id: locationId, companyId } }),
  ]);
  if (!product) throw new AppError(404, "Product not found");
  if (!product.isActive)
    throw new AppError(400, "This product is retired — reactivate it first");
  if (!location) throw new AppError(404, "Location not found");
  return { product, location };
}

export async function createMovement(
  companyId: string,
  userId: string,
  input: CreateMovementInput
) {
  await assertOwnership(companyId, input.productId, input.locationId);

  const signedQuantity = input.quantity * DIRECTION[input.type];

  // The no-negative-stock rule. We check and write inside ONE
  // transaction so two simultaneous sales can't both pass the check
  // and together oversell the shelf.
  return prisma.$transaction(async (tx) => {
    if (signedQuantity < 0) {
      const sum = await tx.stockMovement.aggregate({
        where: {
          companyId,
          productId: input.productId,
          locationId: input.locationId,
        },
        _sum: { quantity: true },
      });
      const current = sum._sum.quantity ?? 0;
      if (current + signedQuantity < 0) {
        throw new AppError(
          400,
          `Not enough stock: only ${current} available at this location`
        );
      }
    }

    return tx.stockMovement.create({
      data: {
        companyId,
        productId: input.productId,
        locationId: input.locationId,
        type: input.type,
        quantity: signedQuantity,
        unitCost: input.unitCost,
        reference: input.reference,
        note: input.note,
        createdById: userId,
      },
      include: {
        product: { select: { id: true, sku: true, name: true } },
        location: { select: { id: true, name: true } },
      },
    });
  });
}

/**
 * A transfer = two diary lines stapled together by one transferId:
 *   -5 at the source, +5 at the destination.
 * Both happen or neither does. The books always balance.
 */
export async function transfer(
  companyId: string,
  userId: string,
  input: TransferInput
) {
  await assertOwnership(companyId, input.productId, input.fromLocationId);
  const toLocation = await prisma.location.findFirst({
    where: { id: input.toLocationId, companyId },
  });
  if (!toLocation) throw new AppError(404, "Destination location not found");

  const transferId = randomUUID(); // the staple

  return prisma.$transaction(async (tx) => {
    const sum = await tx.stockMovement.aggregate({
      where: {
        companyId,
        productId: input.productId,
        locationId: input.fromLocationId,
      },
      _sum: { quantity: true },
    });
    const current = sum._sum.quantity ?? 0;
    if (current < input.quantity) {
      throw new AppError(
        400,
        `Not enough stock to transfer: only ${current} available at source`
      );
    }

    const common = {
      companyId,
      productId: input.productId,
      note: input.note,
      transferId,
      createdById: userId,
    };

    const out = await tx.stockMovement.create({
      data: {
        ...common,
        locationId: input.fromLocationId,
        type: "TRANSFER_OUT",
        quantity: -input.quantity,
      },
    });
    const inn = await tx.stockMovement.create({
      data: {
        ...common,
        locationId: input.toLocationId,
        type: "TRANSFER_IN",
        quantity: input.quantity,
      },
    });

    return { transferId, out, in: inn };
  });
}

/** The diary, newest first, with names attached and pagination. */
export async function listMovements(
  companyId: string,
  q: ListMovementsQuery
) {
  const where = {
    companyId,
    ...(q.productId ? { productId: q.productId } : {}),
    ...(q.locationId ? { locationId: q.locationId } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.stockMovement.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: q.take,
      skip: q.skip,
      include: {
        product: { select: { id: true, sku: true, name: true } },
        location: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
    }),
    prisma.stockMovement.count({ where }),
  ]);

  return { items, total, take: q.take, skip: q.skip };
}

/**
 * Current totals: every product × location combination that has
 * movements, with a lowStock flag the dashboard will love.
 */
export async function stockLevels(companyId: string, q: LevelsQuery) {
  const grouped = await prisma.stockMovement.groupBy({
    by: ["productId", "locationId"],
    where: {
      companyId,
      ...(q.locationId ? { locationId: q.locationId } : {}),
      ...(q.productId ? { productId: q.productId } : {}),
    },
    _sum: { quantity: true },
  });

  // groupBy gives ids only — fetch the names in two quick lookups
  const productIds = [...new Set(grouped.map((g) => g.productId))];
  const locationIds = [...new Set(grouped.map((g) => g.locationId))];

  const [products, locations] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: productIds }, companyId },
      select: { id: true, sku: true, name: true, unit: true, lowStockThreshold: true },
    }),
    prisma.location.findMany({
      where: { id: { in: locationIds }, companyId },
      select: { id: true, name: true },
    }),
  ]);
  const productById = new Map(products.map((p) => [p.id, p]));
  const locationById = new Map(locations.map((l) => [l.id, l]));

  return grouped
    .map((g) => {
      const product = productById.get(g.productId);
      const location = locationById.get(g.locationId);
      const quantity = g._sum.quantity ?? 0;
      if (!product || !location) return null; // shouldn't happen; be safe
      return {
        product,
        location,
        quantity,
        lowStock: quantity <= product.lowStockThreshold,
      };
    })
    .filter((row) => row !== null);
}
