/**
 * Invoice routes.
 *
 * GET   /api/invoices          list
 * GET   /api/invoices/:id      one invoice with lines
 * POST  /api/invoices          create a draft (ADMIN/MANAGER)
 * PATCH /api/invoices/:id      edit a draft (ADMIN/MANAGER)
 * POST  /api/invoices/:id/issue   finalise + deduct stock (ADMIN/MANAGER)
 * POST  /api/invoices/:id/pay     mark paid (ADMIN/MANAGER)
 * POST  /api/invoices/:id/cancel  cancel a draft (ADMIN/MANAGER)
 */
import { Router } from "express";
import { asyncHandler } from "../../middleware/error.js";
import {
  requireAuth,
  requireRole,
  type AuthRequest,
} from "../../middleware/auth.js";
import {
  createInvoiceSchema,
  updateInvoiceSchema,
  listInvoiceQuerySchema,
} from "./inv.schemas.js";
import * as invService from "./inv.service.js";

export const invoicesRouter = Router();
invoicesRouter.use(requireAuth);

invoicesRouter.get(
  "/",
  asyncHandler(async (req: AuthRequest, res) => {
    const q = listInvoiceQuerySchema.parse(req.query);
    res.json(await invService.listInvoices(req.user!.companyId, q));
  })
);

invoicesRouter.get(
  "/:id",
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(await invService.getInvoice(req.user!.companyId, req.params.id));
  })
);

invoicesRouter.post(
  "/",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = createInvoiceSchema.parse(req.body);
    const inv = await invService.createInvoice(
      req.user!.companyId,
      req.user!.userId,
      input
    );
    res.status(201).json(inv);
  })
);

invoicesRouter.patch(
  "/:id",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req: AuthRequest, res) => {
    const input = updateInvoiceSchema.parse(req.body);
    res.json(
      await invService.updateInvoice(req.user!.companyId, req.params.id, input)
    );
  })
);

invoicesRouter.post(
  "/:id/issue",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(
      await invService.issueInvoice(
        req.user!.companyId,
        req.user!.userId,
        req.params.id
      )
    );
  })
);

invoicesRouter.post(
  "/:id/pay",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(await invService.payInvoice(req.user!.companyId, req.params.id));
  })
);

invoicesRouter.post(
  "/:id/cancel",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req: AuthRequest, res) => {
    res.json(await invService.cancelInvoice(req.user!.companyId, req.params.id));
  })
);
