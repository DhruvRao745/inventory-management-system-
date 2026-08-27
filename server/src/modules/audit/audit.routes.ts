/**
 * Activity log — a unified, read-only feed of "what happened" across the
 * company, merged from data we already store. No new table: the stock ledger
 * is already an immutable audit trail; we fold in PO creations and new
 * records (products, suppliers, team) and sort everything by time.
 *
 * GET /api/audit?from&to&kind&take&skip
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/error.js";
import { requireAuth, type AuthRequest } from "../../middleware/auth.js";

const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  kind: z
    .enum(["movement", "purchase_order", "product", "supplier", "user"])
    .optional(),
  take: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

type AuditEvent = {
  id: string;
  at: Date;
  actor: string | null;
  kind: string;
  action: string;
  detail: string;
  link: string | null;
};

const pad = (n: number) => `PO-${String(n).padStart(4, "0")}`;

export const auditRouter = Router();
auditRouter.use(requireAuth);

auditRouter.get(
  "/",
  asyncHandler(async (req: AuthRequest, res) => {
    const q = querySchema.parse(req.query);
    const companyId = req.user!.companyId;
    const created =
      q.from || q.to
        ? {
            ...(q.from ? { gte: new Date(q.from) } : {}),
            ...(q.to ? { lte: new Date(q.to) } : {}),
          }
        : undefined;
    const dateWhere = created ? { createdAt: created } : {};

    // Pull recent slices of each source (bounded), then merge in memory.
    const [movements, pos, products, suppliers, users] = await Promise.all([
      prisma.stockMovement.findMany({
        where: { companyId, ...dateWhere },
        orderBy: { createdAt: "desc" },
        take: 300,
        include: {
          product: { select: { id: true, name: true } },
          location: { select: { name: true } },
          createdBy: { select: { name: true } },
        },
      }),
      prisma.purchaseOrder.findMany({
        where: { companyId, ...dateWhere },
        orderBy: { createdAt: "desc" },
        take: 300,
        include: {
          supplier: { select: { name: true } },
          createdBy: { select: { name: true } },
        },
      }),
      prisma.product.findMany({
        where: { companyId, ...dateWhere },
        orderBy: { createdAt: "desc" },
        take: 300,
      }),
      prisma.supplier.findMany({
        where: { companyId, ...dateWhere },
        orderBy: { createdAt: "desc" },
        take: 300,
      }),
      prisma.user.findMany({
        where: { companyId, ...dateWhere },
        orderBy: { createdAt: "desc" },
        take: 300,
      }),
    ]);

    const events: AuditEvent[] = [];

    for (const m of movements) {
      events.push({
        id: `mv-${m.id}`,
        at: m.createdAt,
        actor: m.createdBy.name,
        kind: "movement",
        action: m.type,
        detail: `${m.quantity.greaterThan(0) ? "+" : ""}${m.quantity.toString()} ${m.product.name} @ ${
          m.location.name
        }${m.reference ? ` (${m.reference})` : ""}`,
        link: `/products/${m.product.id}`,
      });
    }
    for (const po of pos) {
      events.push({
        id: `po-${po.id}`,
        at: po.createdAt,
        actor: po.createdBy.name,
        kind: "purchase_order",
        action: "PO created",
        detail: `${pad(po.number)} · ${po.supplier.name}`,
        link: `/purchase-orders/${po.id}`,
      });
    }
    for (const p of products) {
      events.push({
        id: `pr-${p.id}`,
        at: p.createdAt,
        actor: null,
        kind: "product",
        action: "Product added",
        detail: `${p.name} (${p.sku})`,
        link: `/products/${p.id}`,
      });
    }
    for (const s of suppliers) {
      events.push({
        id: `sp-${s.id}`,
        at: s.createdAt,
        actor: null,
        kind: "supplier",
        action: "Supplier added",
        detail: s.name,
        link: `/suppliers/${s.id}`,
      });
    }
    for (const u of users) {
      events.push({
        id: `us-${u.id}`,
        at: u.createdAt,
        actor: null,
        kind: "user",
        action: "Team member added",
        detail: `${u.name} (${u.role})`,
        link: null,
      });
    }

    const filtered = q.kind ? events.filter((e) => e.kind === q.kind) : events;
    filtered.sort((a, b) => b.at.getTime() - a.at.getTime());

    const page = filtered.slice(q.skip, q.skip + q.take);
    res.json({ items: page, total: filtered.length, take: q.take, skip: q.skip });
  })
);
