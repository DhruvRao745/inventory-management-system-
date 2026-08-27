/**
 * Payment routes (P1-5).
 *
 *   POST   /api/payments            → record money received
 *   GET    /api/payments            → list (filter by invoice or date range)
 *   GET    /api/payments/outstanding → who still owes us money
 *   GET    /api/payments/:id        → one payment
 *   DELETE /api/payments/:id        → undo a mistyped payment
 *
 * Flat module router, matching every other module here rather than nesting
 * under /api/invoices/:id/payments — PRD §22 asks for naming consistency with
 * what already exists, and consistency beats theoretical REST purity.
 */
import { Router } from "express";
import {
  createPaymentSchema,
  listPaymentsQuerySchema,
} from "./payment.schemas.js";
import * as paymentService from "./payment.service.js";
import { asyncHandler } from "../../middleware/error.js";
import {
  requireAuth,
  requireRole,
  type AuthRequest,
} from "../../middleware/auth.js";

export const paymentsRouter = Router();
paymentsRouter.use(requireAuth);

// Recording money is a bookkeeping act, not a stock one — managers and admins.
const canHandleMoney = requireRole("ADMIN", "MANAGER");

paymentsRouter.post(
  "/",
  canHandleMoney,
  asyncHandler(async (req: AuthRequest, res) => {
    const input = createPaymentSchema.parse(req.body);
    const result = await paymentService.recordPayment(
      req.user!.companyId,
      req.user!.userId,
      input
    );
    res.status(201).json(result);
  })
);

// Before /:id, or "outstanding" would be read as an id.
paymentsRouter.get(
  "/outstanding",
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(await paymentService.outstandingBalances(req.user!.companyId));
  })
);

paymentsRouter.get(
  "/",
  asyncHandler(async (req: AuthRequest, res) => {
    const q = listPaymentsQuerySchema.parse(req.query);
    res.json(await paymentService.listPayments(req.user!.companyId, q));
  })
);

paymentsRouter.get(
  "/:id",
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(
      await paymentService.getPayment(req.user!.companyId, req.params.id)
    );
  })
);

paymentsRouter.delete(
  "/:id",
  canHandleMoney,
  asyncHandler(async (req: AuthRequest, res) => {
    const result = await paymentService.deletePayment(
      req.user!.companyId,
      req.params.id
    );
    res.json(result);
  })
);
