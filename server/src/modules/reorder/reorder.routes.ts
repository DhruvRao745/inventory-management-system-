/**
 * Reorder settings + the location-aware reorder report (P1-8).
 *
 *   GET    /api/reorder            → what to buy, shelf by shelf
 *   GET    /api/reorder/settings   → per-location rules
 *   PUT    /api/reorder/settings   → set the rule for one shelf (upsert)
 *   DELETE /api/reorder/settings/:id → revert that shelf to the product default
 *   POST   /api/reorder/generate-pos → DRAFT purchase orders from the report (P3-1)
 *
 * PUT rather than POST for the upsert: there is exactly one rule per
 * (product, location), so "set the rule for this shelf" is idempotent.
 */
import { Router } from "express";
import { z } from "zod";
import {
  upsertSettingSchema,
  listSettingsQuerySchema,
  reorderQuerySchema,
} from "./reorder.schemas.js";
import * as service from "./reorder.service.js";
import { asyncHandler } from "../../middleware/error.js";
import {
  requireAuth,
  requireRole,
  type AuthRequest,
} from "../../middleware/auth.js";

export const reorderRouter = Router();
reorderRouter.use(requireAuth);

const canEdit = requireRole("ADMIN", "MANAGER");

// Settings BEFORE the bare "/" report route isn't necessary (different paths),
// but keeping them grouped makes the file read in the order a reader expects.
reorderRouter.get(
  "/settings",
  asyncHandler(async (req: AuthRequest, res) => {
    const q = listSettingsQuerySchema.parse(req.query);
    res.json(await service.listSettings(req.user!.companyId, q));
  })
);

reorderRouter.put(
  "/settings",
  canEdit,
  asyncHandler(async (req: AuthRequest, res) => {
    const input = upsertSettingSchema.parse(req.body);
    res.json(await service.upsertSetting(req.user!.companyId, input));
  })
);

reorderRouter.delete(
  "/settings/:id",
  canEdit,
  asyncHandler(async (req: AuthRequest, res) => {
    await service.deleteSetting(req.user!.companyId, req.params.id);
    res.status(204).send();
  })
);

reorderRouter.get(
  "/",
  asyncHandler(async (req: AuthRequest, res) => {
    const q = reorderQuerySchema.parse(req.query);
    res.json(await service.reorderReport(req.user!.companyId, q));
  })
);

/**
 * POST /api/reorder/generate-pos — draft purchase orders from the report.
 *
 * Restricted to the roles that can already create purchase orders. It creates
 * DRAFTS only; nothing here can place an order with a supplier, and the
 * generator has no way to set any status but DRAFT.
 */
reorderRouter.post(
  "/generate-pos",
  canEdit,
  asyncHandler(async (req: AuthRequest, res) => {
    const input = z
      .object({
        locationId: z.string().optional(),
        /** Limit to specific products; omit to take every recommendation. */
        productIds: z.array(z.string()).optional(),
      })
      .parse(req.body ?? {});

    const result = await service.generateDraftPOs(
      req.user!.companyId,
      req.user!.userId,
      input
    );
    res.status(201).json(result);
  })
);
