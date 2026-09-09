/**
 * Point of sale (P3-4).
 *
 *   POST /api/pos/sale  → ring up a counter sale
 *   POST /api/pos/quote → what will this basket cost, including tax?
 *
 * TWO ROUTES, and the second one earns its place rather than widening the
 * surface for convenience. A till has to say the amount out loud and count
 * change against it BEFORE money changes hands, and only the server knows what
 * tax applies. The alternative was a tax calculation in the browser, which is
 * the second engine this codebase refuses to have. `quote` writes nothing.
 *
 * A till also needs to find products by barcode, list locations, and print an
 * invoice — and every one of those already exists (`GET /products/lookup`,
 * `GET /locations`, `GET /invoices/:id`). Adding POS-flavoured copies of them
 * here would be the first step toward the separate system the spec forbids,
 * so the till screen calls the ordinary endpoints like every other screen.
 *
 * Online-only, per the spec: no queueing, no offline sync, no client-generated
 * identifiers. A sale that cannot reach the server does not happen, and the
 * operator finds out immediately rather than discovering at closing time that
 * a queue never drained.
 */
import { Router } from "express";
import { posSaleSchema, posQuoteSchema } from "./pos.schemas.js";
import * as service from "./pos.service.js";
import { asyncHandler } from "../../middleware/error.js";
import {
  requireAuth,
  requireRole,
  type AuthRequest,
} from "../../middleware/auth.js";

export const posRouter = Router();
posRouter.use(requireAuth);

/**
 * STAFF and up. A counter sale is the most junior operation in the system —
 * gating it to managers would leave a shop unable to serve customers whenever
 * the manager is out, and staff can already issue invoices, which is the same
 * act through a different screen.
 */
posRouter.post(
  "/sale",
  requireRole("ADMIN", "MANAGER", "STAFF"),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = posSaleSchema.parse(req.body);
    const result = await service.posSale(
      req.user!.companyId,
      req.user!.userId,
      input
    );
    res.status(201).json(result);
  })
);

/**
 * A price check. Same permissions as a sale, because it is the same act one
 * moment earlier — and it changes nothing, so there is nothing to guard.
 */
posRouter.post(
  "/quote",
  requireRole("ADMIN", "MANAGER", "STAFF"),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = posQuoteSchema.parse(req.body);
    res.json(await service.posQuote(req.user!.companyId, input));
  })
);
