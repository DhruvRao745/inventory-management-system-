/**
 * Products routes — the counter of the item register.
 *
 * The five classic doors of CRUD:
 *   GET    /api/products      → list (with ?search=...)
 *   GET    /api/products/:id  → one item
 *   POST   /api/products      → add            (MANAGER/ADMIN only)
 *   PATCH  /api/products/:id  → edit some fields (MANAGER/ADMIN only)
 *   DELETE /api/products/:id  → retire (soft)    (MANAGER/ADMIN only)
 *
 * PATCH vs PUT, since you'll see both in the wild: PUT replaces the
 * whole record, PATCH changes only the fields you send. We use PATCH.
 */
import { Router } from "express";
import {
  createProductSchema,
  updateProductSchema,
  listProductsQuerySchema,
  importProductsSchema,
} from "./product.schemas.js";
import * as productService from "./product.service.js";
import { asyncHandler } from "../../middleware/error.js";
import {
  requireAuth,
  requireRole,
  type AuthRequest,
} from "../../middleware/auth.js";

export const productsRouter = Router();

// Every products door needs a badge — apply the guard to the whole router
productsRouter.use(requireAuth);

const canWrite = requireRole("ADMIN", "MANAGER");

productsRouter.get(
  "/",
  asyncHandler(async (req: AuthRequest, res) => {
    const query = listProductsQuerySchema.parse(req.query);
    const products = await productService.listProducts(
      req.user!.companyId,
      query
    );
    res.json(products);
  })
);

// Barcode lookup for the scan stations — MUST be declared before "/:id"
// so "/lookup" isn't captured as an id.
productsRouter.get(
  "/lookup",
  asyncHandler(async (req: AuthRequest, res) => {
    const barcode = String(req.query.barcode ?? "").trim();
    if (!barcode) {
      res.status(400).json({ error: "barcode is required" });
      return;
    }
    const product = await productService.getProductByBarcode(
      req.user!.companyId,
      barcode
    );
    res.json(product);
  })
);

productsRouter.get(
  "/:id",
  asyncHandler(async (req: AuthRequest, res) => {
    const product = await productService.getProduct(
      req.user!.companyId,
      req.params.id
    );
    res.json(product);
  })
);

productsRouter.post(
  "/",
  canWrite,
  asyncHandler(async (req: AuthRequest, res) => {
    const input = createProductSchema.parse(req.body);
    const product = await productService.createProduct(
      req.user!.companyId,
      input
    );
    res.status(201).json(product);
  })
);

productsRouter.post(
  "/import",
  canWrite,
  asyncHandler(async (req: AuthRequest, res) => {
    const { rows } = importProductsSchema.parse(req.body);
    const result = await productService.importProducts(
      req.user!.companyId,
      rows
    );
    res.json(result);
  })
);

productsRouter.patch(
  "/:id",
  canWrite,
  asyncHandler(async (req: AuthRequest, res) => {
    const input = updateProductSchema.parse(req.body);
    const product = await productService.updateProduct(
      req.user!.companyId,
      req.params.id,
      input,
      req.user!.userId
    );
    res.json(product);
  })
);

productsRouter.delete(
  "/:id",
  canWrite,
  asyncHandler(async (req: AuthRequest, res) => {
    await productService.deactivateProduct(req.user!.companyId, req.params.id);
    res.status(204).send(); // 204 = "done, nothing to say"
  })
);
