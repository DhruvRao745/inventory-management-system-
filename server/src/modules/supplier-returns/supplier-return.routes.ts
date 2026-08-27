/**
 * Supplier returns + goods receipts (P1-7).
 *
 *   POST  /api/supplier-returns             → draft a return to a supplier
 *   GET   /api/supplier-returns             → list
 *   GET   /api/supplier-returns/receipts    → goods receipts (deliveries)
 *   GET   /api/supplier-returns/receipts/:id
 *   GET   /api/supplier-returns/:id
 *   PATCH /api/supplier-returns/:id         → edit reason/notes
 *   POST  /api/supplier-returns/:id/send    → goods leave — STOCK DECREASES
 *   POST  /api/supplier-returns/:id/complete
 *   POST  /api/supplier-returns/:id/cancel
 *
 * Goods receipts are read-only here: they're CREATED by receiving against a
 * purchase order (POST /api/purchase-orders/:id/receive), because a delivery
 * only means something in the context of the order it fulfils.
 */
import { Router } from "express";
import { z } from "zod";
import {
  createSupplierReturnSchema,
  updateSupplierReturnSchema,
  listSupplierReturnsQuerySchema,
} from "./supplier-return.schemas.js";
import * as service from "./supplier-return.service.js";
import { asyncHandler } from "../../middleware/error.js";
import {
  requireAuth,
  requireRole,
  type AuthRequest,
} from "../../middleware/auth.js";

export const supplierReturnsRouter = Router();
supplierReturnsRouter.use(requireAuth);

// Sending goods back to a supplier moves stock and money — a decision.
const canDecide = requireRole("ADMIN", "MANAGER");

const receiptQuerySchema = z.object({
  purchaseOrderId: z.string().optional(),
  take: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

// Receipts BEFORE /:id, or "receipts" gets read as an id.
supplierReturnsRouter.get(
  "/receipts",
  asyncHandler(async (req: AuthRequest, res) => {
    const q = receiptQuerySchema.parse(req.query);
    res.json(await service.listGoodsReceipts(req.user!.companyId, q));
  })
);

supplierReturnsRouter.get(
  "/receipts/:id",
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(
      await service.getGoodsReceipt(req.user!.companyId, req.params.id)
    );
  })
);

supplierReturnsRouter.post(
  "/",
  canDecide,
  asyncHandler(async (req: AuthRequest, res) => {
    const input = createSupplierReturnSchema.parse(req.body);
    const ret = await service.createSupplierReturn(
      req.user!.companyId,
      req.user!.userId,
      input
    );
    res.status(201).json(ret);
  })
);

supplierReturnsRouter.get(
  "/",
  asyncHandler(async (req: AuthRequest, res) => {
    const q = listSupplierReturnsQuerySchema.parse(req.query);
    res.json(await service.listSupplierReturns(req.user!.companyId, q));
  })
);

supplierReturnsRouter.get(
  "/:id",
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(
      await service.getSupplierReturn(req.user!.companyId, req.params.id)
    );
  })
);

supplierReturnsRouter.patch(
  "/:id",
  canDecide,
  asyncHandler(async (req: AuthRequest, res) => {
    const input = updateSupplierReturnSchema.parse(req.body);
    res.json(
      await service.updateSupplierReturn(
        req.user!.companyId,
        req.params.id,
        input
      )
    );
  })
);

supplierReturnsRouter.post(
  "/:id/send",
  canDecide,
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(
      await service.sendSupplierReturn(
        req.user!.companyId,
        req.user!.userId,
        req.params.id
      )
    );
  })
);

supplierReturnsRouter.post(
  "/:id/complete",
  canDecide,
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(
      await service.completeSupplierReturn(req.user!.companyId, req.params.id)
    );
  })
);

supplierReturnsRouter.post(
  "/:id/cancel",
  canDecide,
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(
      await service.cancelSupplierReturn(req.user!.companyId, req.params.id)
    );
  })
);
