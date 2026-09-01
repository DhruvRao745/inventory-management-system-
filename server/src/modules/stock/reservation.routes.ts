/**
 * Reservations — read-only endpoints (P2-1).
 *
 *   GET /api/reservations                  → active holds, filterable
 *   GET /api/reservations/availability     → on hand / reserved / available
 *
 * There is deliberately NO manual create endpoint. Reservations are created by
 * draft invoices and released when those drafts are issued or cancelled, so
 * every hold has an owner that can explain it. A free-floating "reserve 5 of
 * these" with nothing behind it is a hold nobody will ever remember to release,
 * and stock that quietly stops being sellable for no recorded reason is worse
 * than no reservation feature at all.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { availableQuantity } from "../../lib/reservations.js";
import { asyncHandler } from "../../middleware/error.js";
import { AppError } from "../../middleware/error.js";
import { requireAuth, type AuthRequest } from "../../middleware/auth.js";

export const reservationsRouter = Router();
reservationsRouter.use(requireAuth);

const listQuerySchema = z.object({
  productId: z.string().optional(),
  locationId: z.string().optional(),
  status: z.enum(["ACTIVE", "CONSUMED", "RELEASED"]).optional(),
  take: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

const availabilityQuerySchema = z.object({
  productId: z.string().min(1, "productId is required"),
  locationId: z.string().min(1, "locationId is required"),
});

// availability BEFORE any "/:id" style route, or it gets read as an id.
reservationsRouter.get(
  "/availability",
  asyncHandler(async (req: AuthRequest, res) => {
    const q = availabilityQuerySchema.parse(req.query);
    const companyId = req.user!.companyId;

    // Tenant check before answering. Without it, a guessed UUID from another
    // company would come back as "0 on hand" — which quietly confirms the id
    // does not belong here, and answers a question that was never ours to
    // answer (PRD §14).
    const [product, location] = await Promise.all([
      prisma.product.findFirst({
        where: { id: q.productId, companyId },
        select: { id: true, name: true, unit: true },
      }),
      prisma.location.findFirst({
        where: { id: q.locationId, companyId },
        select: { id: true, name: true },
      }),
    ]);
    if (!product) throw new AppError(404, "Product not found");
    if (!location) throw new AppError(404, "Location not found");

    const { onHand, sellable, reserved, available } = await availableQuantity(
      prisma,
      companyId,
      { productId: q.productId, locationId: q.locationId }
    );

    // All four numbers, because they answer four different questions:
    // what we own, what we may sell, what's promised, what's still free.
    res.json({ product, location, onHand, sellable, reserved, available });
  })
);

reservationsRouter.get(
  "/",
  asyncHandler(async (req: AuthRequest, res) => {
    const q = listQuerySchema.parse(req.query);
    const companyId = req.user!.companyId;

    const where = {
      companyId,
      // Default to ACTIVE: the question people actually ask is "what is being
      // held right now", not "everything that was ever held".
      status: q.status ?? ("ACTIVE" as const),
      ...(q.productId ? { productId: q.productId } : {}),
      ...(q.locationId ? { locationId: q.locationId } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.stockReservation.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: q.take,
        skip: q.skip,
        include: {
          product: { select: { id: true, sku: true, name: true, unit: true } },
          location: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true } },
        },
      }),
      prisma.stockReservation.count({ where }),
    ]);

    // Resolve what each hold is FOR. A reservation list that says "5 units
    // held" without saying by what is a list of mysteries.
    const invoiceIds = items
      .filter((i) => i.sourceType === "invoice")
      .map((i) => i.sourceId);
    const invoices = invoiceIds.length
      ? await prisma.invoice.findMany({
          where: { id: { in: invoiceIds }, companyId },
          select: { id: true, number: true, customerName: true, status: true },
        })
      : [];
    const invoiceById = new Map(invoices.map((i) => [i.id, i]));

    res.json({
      items: items.map((i) => ({
        ...i,
        source:
          i.sourceType === "invoice"
            ? (invoiceById.get(i.sourceId) ?? null)
            : null,
      })),
      total,
      take: q.take,
      skip: q.skip,
    });
  })
);
