/**
 * Sales return routes (P1-6).
 *
 *   POST  /api/returns              → raise a return request
 *   GET   /api/returns              → list
 *   GET   /api/returns/returnable/:invoiceId → what's still returnable
 *   GET   /api/returns/:id          → one return
 *   PATCH /api/returns/:id          → edit reason/notes/refund amount
 *   POST  /api/returns/:id/approve  → agree to take it back
 *   POST  /api/returns/:id/receive  → goods arrived — STOCK MOVES HERE
 *   POST  /api/returns/:id/refund   → record the refund
 *   POST  /api/returns/:id/cancel   → call it off (before receiving)
 *
 * Status transitions are POSTs to named sub-paths, matching how invoices and
 * purchase orders already do it (/issue, /pay, /receive) — PRD §22 asks for
 * consistency with existing conventions.
 */
import { Router } from "express";
import {
  createReturnSchema,
  updateReturnSchema,
  listReturnsQuerySchema,
  refundSchema,
} from "./return.schemas.js";
import * as returnService from "./return.service.js";
import { asyncHandler } from "../../middleware/error.js";
import {
  requireAuth,
  requireRole,
  type AuthRequest,
} from "../../middleware/auth.js";

export const returnsRouter = Router();
returnsRouter.use(requireAuth);

// Anyone can raise a return request — it's the customer-facing end, and it
// moves no stock. Approving, receiving and refunding are decisions.
const canDecide = requireRole("ADMIN", "MANAGER");

returnsRouter.post(
  "/",
  asyncHandler(async (req: AuthRequest, res) => {
    const input = createReturnSchema.parse(req.body);
    const ret = await returnService.createReturn(
      req.user!.companyId,
      req.user!.userId,
      input
    );
    res.status(201).json(ret);
  })
);

returnsRouter.get(
  "/",
  asyncHandler(async (req: AuthRequest, res) => {
    const q = listReturnsQuerySchema.parse(req.query);
    res.json(await returnService.listReturns(req.user!.companyId, q));
  })
);

// Before /:id so "returnable" isn't read as an id.
returnsRouter.get(
  "/returnable/:invoiceId",
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(
      await returnService.returnableFor(
        req.user!.companyId,
        req.params.invoiceId
      )
    );
  })
);

returnsRouter.get(
  "/:id",
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(await returnService.getReturn(req.user!.companyId, req.params.id));
  })
);

returnsRouter.patch(
  "/:id",
  canDecide,
  asyncHandler(async (req: AuthRequest, res) => {
    const input = updateReturnSchema.parse(req.body);
    res.json(
      await returnService.updateReturn(
        req.user!.companyId,
        req.params.id,
        input
      )
    );
  })
);

returnsRouter.post(
  "/:id/approve",
  canDecide,
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(
      await returnService.approveReturn(
        req.user!.companyId,
        req.user!.userId,
        req.params.id
      )
    );
  })
);

returnsRouter.post(
  "/:id/receive",
  canDecide,
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(
      await returnService.receiveReturn(
        req.user!.companyId,
        req.user!.userId,
        req.params.id
      )
    );
  })
);

returnsRouter.post(
  "/:id/refund",
  canDecide,
  asyncHandler(async (req: AuthRequest, res) => {
    const input = refundSchema.parse(req.body);
    res.json(
      await returnService.refundReturn(
        req.user!.companyId,
        req.params.id,
        input
      )
    );
  })
);

returnsRouter.post(
  "/:id/cancel",
  canDecide,
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(
      await returnService.cancelReturn(req.user!.companyId, req.params.id)
    );
  })
);
