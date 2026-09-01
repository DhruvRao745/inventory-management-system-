/**
 * Express app configuration.
 *
 * WHY a separate file from index.ts: the app (routes + middleware) is defined
 * here WITHOUT starting a network listener. That lets tests import the app
 * and hit it in-memory, and keeps "what the API does" separate from
 * "how it runs".
 */
import path from "node:path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env.js";
import { authIpLimiter } from "./middleware/rateLimit.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { productsRouter } from "./modules/products/product.routes.js";
import { locationsRouter } from "./modules/locations/location.routes.js";
import { stockRouter } from "./modules/stock/stock.routes.js";
import { usersRouter } from "./modules/users/user.routes.js";
import { categoriesRouter } from "./modules/categories/category.routes.js";
import { reportsRouter } from "./modules/reports/report.routes.js";
import { companyRouter } from "./modules/company/company.routes.js";
import { suppliersRouter } from "./modules/suppliers/supplier.routes.js";
import { purchaseOrdersRouter } from "./modules/purchase-orders/po.routes.js";
import { auditRouter } from "./modules/audit/audit.routes.js";
import { invoicesRouter } from "./modules/invoices/inv.routes.js";
import { customersRouter } from "./modules/customers/customer.routes.js";
import { paymentsRouter } from "./modules/payments/payment.routes.js";
import { returnsRouter } from "./modules/returns/return.routes.js";
import { supplierReturnsRouter } from "./modules/supplier-returns/supplier-return.routes.js";
import { reorderRouter } from "./modules/reorder/reorder.routes.js";
import { stockCountsRouter } from "./modules/stock-counts/count.routes.js";
import { reservationsRouter } from "./modules/stock/reservation.routes.js";
import { errorHandler } from "./middleware/error.js";

export const app = express();

const isProduction = env.NODE_ENV === "production";

// Behind a proxy/load balancer (production), requests appear to come
// from the proxy's IP. This tells Express to trust the proxy's
// X-Forwarded-For header so rate limiters see the real visitor.
if (isProduction) {
  app.set("trust proxy", 1);
}

// --- Global middleware (runs on every request, in order) ---
// CSP: off in dev (it blocks Vite's live-reload). In production we keep
// helmet's protections but allow the jsDelivr CDN — the camera scanner
// (html5-qrcode) and the barcode/QR label generators load from there at
// runtime, and the default CSP ('self' only) would block them.
app.use(
  helmet({
    contentSecurityPolicy: isProduction
      ? {
          useDefaults: true,
          directives: {
            "script-src": ["'self'", "https://cdn.jsdelivr.net"],
            "connect-src": ["'self'", "https://cdn.jsdelivr.net"],
            "img-src": ["'self'", "data:", "blob:"],
            "media-src": ["'self'", "blob:"], // camera stream
            "worker-src": ["'self'", "blob:"], // scanner decode worker
          },
        }
      : false,
  })
);
app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true })); // dev: allow the React dev server
app.use(express.json()); // parse JSON request bodies into req.body

// --- Routes ---
// Health check: load balancers, uptime monitors, and our own frontend
// use this to ask "is the API alive?"
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "inventory-api", time: new Date().toISOString() });
});

// Rate limiting: loose per-IP net over all auth routes; the strict
// per-credential bouncer sits directly on the login route itself.
// (When deployed behind a proxy, set app.set("trust proxy", 1) so
// limiters see the real visitor IP, not the proxy's.)

// Feature modules — each mounted under its own /api prefix
app.use("/api/auth", authIpLimiter, authRouter);
app.use("/api/products", productsRouter);
app.use("/api/locations", locationsRouter);
app.use("/api/stock", stockRouter);
app.use("/api/users", usersRouter);
app.use("/api/categories", categoriesRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/company", companyRouter);
app.use("/api/suppliers", suppliersRouter);
app.use("/api/purchase-orders", purchaseOrdersRouter);
app.use("/api/audit", auditRouter);
app.use("/api/invoices", invoicesRouter);
app.use("/api/customers", customersRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/returns", returnsRouter);
app.use("/api/supplier-returns", supplierReturnsRouter);
app.use("/api/reorder", reorderRouter);
app.use("/api/stock-counts", stockCountsRouter);
app.use("/api/reservations", reservationsRouter);

// --- 404 for unknown API routes (always JSON, never HTML) ---
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

if (isProduction) {
  // --- Production: Express serves the built React app itself ---
  // The Docker build copies client/dist into server/public.
  const publicDir = path.resolve(__dirname, "../public");
  app.use(express.static(publicDir));

  // SPA fallback: any non-API address returns index.html so React
  // Router can handle it — this is what makes a bookmarked
  // /products/abc123 survive a page refresh in production.
  app.get("*", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
} else {
  // --- Development: Vite serves the client; anything else is a 404 ---
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
}

// --- Error handler: MUST be last. All errors flow down here. ---
app.use(errorHandler);
