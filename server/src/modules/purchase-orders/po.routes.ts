/**
 * Purchase-order routes.
 *
 * GET   /api/purchase-orders        list (everyone logged in)
 * GET   /api/purchase-orders/:id    one PO with its lines
 * POST  /api/purchase-orders        create a draft (ADMIN/MANAGER)
 * PATCH /api/purchase-orders/:id    edit a draft (ADMIN/MANAGER)
 * PATCH /api/purchase-orders/:id/status   place / cancel (ADMIN/MANAGER)
 */
import { Router } from "express";
import { asyncHandler } from "../../middleware/error.js";
import {
  requireAuth,
  requireRole,
  type AuthRequest,
} from "../../middleware/auth.js";
import {
  createPOSchema,
  updatePOSchema,
  statusChangeSchema,
  listPOQuerySchema,
  receiveSchema,
} from "./po.schemas.js";
import * as poService from "./po.service.js";

export const purchaseOrdersRouter = Router();
purchaseOrdersRouter.use(requireAuth);

purchaseOrdersRouter.get(
  "/",
  asyncHandler(async (req: AuthRequest, res) => {
    const query = listPOQuerySchema.parse(req.query);
    res.json(await poService.listPOs(req.user!.companyId, query));
  })
);

purchaseOrdersRouter.get(
  "/:id",
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(await poService.getPO(req.user!.companyId, req.params.id));
  })
);

purchaseOrdersRouter.post(
  "/",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = createPOSchema.parse(req.body);
    const po = await poService.createPO(
      req.user!.companyId,
      req.user!.userId,
      input
    );
    res.status(201).json(po);
  })
);

purchaseOrdersRouter.patch(
  "/:id",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = updatePOSchema.parse(req.body);
    res.json(
      await poService.updatePO(req.user!.companyId, req.params.id, input)
    );
  })
);

purchaseOrdersRouter.patch(
  "/:id/status",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req: AuthRequest, res) => {
    const { status } = statusChangeSchema.parse(req.body);
    res.json(
      await poService.changeStatus(req.user!.companyId, req.params.id, status)
    );
  })
);

// Receive stock against the PO (partial or full).
purchaseOrdersRouter.post(
  "/:id/receive",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = receiveSchema.parse(req.body);
    res.json(
      await poService.receivePO(
        req.user!.companyId,
        req.user!.userId,
        req.params.id,
        input
      )
    );
  })
);
