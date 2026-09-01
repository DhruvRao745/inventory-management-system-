/**
 * Stock routes — the diary counter.
 *
 *   POST /api/stock/movements  → write a diary line (any logged-in user)
 *   POST /api/stock/reclassify → move stock between conditions (ADMIN/MANAGER)
 *   POST /api/stock/transfer   → move goods between locations
 *   GET  /api/stock/movements  → read the diary (history)
 *   GET  /api/stock/levels     → current totals + low-stock flags
 *
 * No PATCH. No DELETE. The diary is written in pen — which is exactly why
 * reclassifying stock POSTs two new lines rather than editing old ones.
 */
import { Router } from "express";
import {
  createMovementSchema,
  transferSchema,
  reclassifySchema,
  listMovementsQuerySchema,
  levelsQuerySchema,
  batchQuerySchema,
} from "./stock.schemas.js";
import * as stockService from "./stock.service.js";
import * as batchService from "./batch.service.js";
import { asyncHandler } from "../../middleware/error.js";
import {
  requireAuth,
  requireRole,
  type AuthRequest,
} from "../../middleware/auth.js";

export const stockRouter = Router();
stockRouter.use(requireAuth);

stockRouter.post(
  "/movements",
  asyncHandler(async (req: AuthRequest, res) => {
    const input = createMovementSchema.parse(req.body);
    const movement = await stockService.createMovement(
      req.user!.companyId,
      req.user!.userId,
      input
    );
    res.status(201).json(movement);
  })
);

stockRouter.post(
  "/reclassify",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = reclassifySchema.parse(req.body);
    const result = await stockService.reclassifyStock(
      req.user!.companyId,
      req.user!.userId,
      input
    );
    res.status(201).json(result);
  })
);

stockRouter.post(
  "/transfer",
  asyncHandler(async (req: AuthRequest, res) => {
    const input = transferSchema.parse(req.body);
    const result = await stockService.transfer(
      req.user!.companyId,
      req.user!.userId,
      input
    );
    res.status(201).json(result);
  })
);

stockRouter.get(
  "/movements",
  asyncHandler(async (req: AuthRequest, res) => {
    const query = listMovementsQuerySchema.parse(req.query);
    const result = await stockService.listMovements(
      req.user!.companyId,
      query
    );
    res.json(result);
  })
);

stockRouter.get(
  "/levels",
  asyncHandler(async (req: AuthRequest, res) => {
    const query = levelsQuerySchema.parse(req.query);
    const result = await stockService.stockLevels(req.user!.companyId, query);
    res.json(result);
  })
);

// GET /api/stock/batches — live lots, nearest expiry first (P1-1).
//   ?expiringInDays=30  → the "what's about to go off" view
//   ?includeEmpty=true  → include fully-consumed lots (history)
stockRouter.get(
  "/batches",
  asyncHandler(async (req: AuthRequest, res) => {
    const q = batchQuerySchema.parse(req.query);
    const batches = await batchService.listBatches(req.user!.companyId, {
      productId: q.productId,
      locationId: q.locationId,
      includeEmpty: q.includeEmpty,
      expiringBefore:
        q.expiringInDays === undefined
          ? undefined
          : new Date(Date.now() + q.expiringInDays * 24 * 60 * 60 * 1000),
    });
    res.json({ items: batches, total: batches.length });
  })
);
