/**
 * Express app configuration.
 *
 * WHY a separate file from index.ts: the app (routes + middleware) is defined
 * here WITHOUT starting a network listener. That lets tests import the app
 * and hit it in-memory, and keeps "what the API does" separate from
 * "how it runs".
 */
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { authRouter } from "./modules/auth/auth.routes.js";
import { productsRouter } from "./modules/products/product.routes.js";
import { errorHandler } from "./middleware/error.js";

export const app = express();

// --- Global middleware (runs on every request, in order) ---
app.use(helmet()); // sets security-related HTTP headers
app.use(cors({ origin: "http://localhost:5173", credentials: true })); // allow the React dev server to call us
app.use(express.json()); // parse JSON request bodies into req.body

// --- Routes ---
// Health check: load balancers, uptime monitors, and our own frontend
// use this to ask "is the API alive?"
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "inventory-api", time: new Date().toISOString() });
});

// Feature modules — each mounted under its own /api prefix
app.use("/api/auth", authRouter);
app.use("/api/products", productsRouter);

// --- 404 handler: anything that matched no route above ---
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// --- Error handler: MUST be last. All errors flow down here. ---
app.use(errorHandler);
