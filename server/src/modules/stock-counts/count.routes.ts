/**
 * Stock count routes (P1-9).
 *
 *   POST /api/stock-counts             → prepare a count sheet
 *   GET  /api/stock-counts             → list
 *   GET  /api/stock-counts/:id
 *   POST /api/stock-counts/:id/start   → OPEN → COUNTING
 *   POST /api/stock-counts/:id/record  → enter one line's figure
 *   POST /api/stock-counts/:id/review  → COUNTING → REVIEW
 *   POST /api/stock-counts/:id/complete → writes ADJUSTMENT movements
 *   POST /api/stock-counts/:id/cancel
 */
import { Router } from "express";
import {
  createCountSchema,
  recordCountSchema,
  listCountsQuerySchema,
} from "./count.schemas.js";
import * as service from "./count.service.js";
import { asyncHandler } from "../../middleware/error.js";
import {
  requireAuth,
  requireRole,
  type AuthRequest,
} from "../../middleware/auth.js";

export const stockCountsRouter = Router();
stockCountsRouter.use(requireAuth);

// Counting is floor work — any signed-in user can enter figures.
// Applying the adjustments to the ledger is a decision.
const canApprove = requireRole("ADMIN", "MANAGER");

stockCountsRouter.post(
  "/",
  canApprove,
  asyncHandler(async (req: AuthRequest, res) => {
    const input = createCountSchema.parse(req.body);
    const count = await service.createCount(
      req.user!.companyId,
      req.user!.userId,
      input
    );
    res.status(201).json(count);
  })
);

stockCountsRouter.get(
  "/",
  asyncHandler(async (req: AuthRequest, res) => {
    const q = listCountsQuerySchema.parse(req.query);
    res.json(await service.listCounts(req.user!.companyId, q));
  })
);

stockCountsRouter.get(
  "/:id",
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(await service.getCount(req.user!.companyId, req.params.id));
  })
);

stockCountsRouter.post(
  "/:id/start",
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(await service.startCounting(req.user!.companyId, req.params.id));
  })
);

stockCountsRouter.post(
  "/:id/record",
  asyncHandler(async (req: AuthRequest, res) => {
    const input = recordCountSchema.parse(req.body);
    res.json(
      await service.recordCount(req.user!.companyId, req.params.id, input)
    );
  })
);

stockCountsRouter.post(
  "/:id/review",
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(await service.submitForReview(req.user!.companyId, req.params.id));
  })
);

stockCountsRouter.post(
  "/:id/complete",
  canApprove,
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(
      await service.completeCount(
        req.user!.companyId,
        req.user!.userId,
        req.params.id
      )
    );
  })
);

stockCountsRouter.post(
  "/:id/cancel",
  canApprove,
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(await service.cancelCount(req.user!.companyId, req.params.id));
  })
);
