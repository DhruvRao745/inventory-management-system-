-- P0 — database integrity constraints (PRD §21)
--
-- The LAST line of defence, not the first. Application code and Zod already
-- enforce every rule below; these constraints mean that if a future code path
-- forgets one, Postgres refuses the write instead of silently corrupting the
-- ledger.
--
-- Every constraint mirrors a rule the current schemas already guarantee, so
-- existing rows should satisfy them. If a migration fails here, that is a
-- genuine finding — real data already violates an invariant we believed held.
--
-- NOTE: CHECK constraints cannot be expressed in schema.prisma, so this is a
-- hand-written migration. Prisma does not model them and will not try to drop
-- them on later `migrate dev` runs.

-- ---------------------------------------------------------------
-- Stock ledger
-- ---------------------------------------------------------------
-- A movement of zero is meaningless noise in an audit trail.
ALTER TABLE "StockMovement"
  ADD CONSTRAINT "StockMovement_quantity_nonzero"
  CHECK ("quantity" <> 0);

-- Cost may be absent (adjustments, transfers) but never negative.
ALTER TABLE "StockMovement"
  ADD CONSTRAINT "StockMovement_unitCost_nonneg"
  CHECK ("unitCost" IS NULL OR "unitCost" >= 0);

-- ---------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------
ALTER TABLE "Product"
  ADD CONSTRAINT "Product_costPrice_nonneg"
  CHECK ("costPrice" >= 0);

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_sellingPrice_nonneg"
  CHECK ("sellingPrice" >= 0);

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_lowStockThreshold_nonneg"
  CHECK ("lowStockThreshold" >= 0);

-- ---------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------
ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_discount_nonneg"
  CHECK ("discount" IS NULL OR "discount" >= 0);

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_taxRate_valid"
  CHECK ("taxRate" IS NULL OR ("taxRate" >= 0 AND "taxRate" <= 100));

ALTER TABLE "InvoiceLine"
  ADD CONSTRAINT "InvoiceLine_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "InvoiceLine"
  ADD CONSTRAINT "InvoiceLine_unitPrice_nonneg"
  CHECK ("unitPrice" >= 0);

-- ---------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------
ALTER TABLE "PurchaseOrderLine"
  ADD CONSTRAINT "PurchaseOrderLine_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "PurchaseOrderLine"
  ADD CONSTRAINT "PurchaseOrderLine_unitCost_nonneg"
  CHECK ("unitCost" >= 0);

ALTER TABLE "PurchaseOrderLine"
  ADD CONSTRAINT "PurchaseOrderLine_receivedQty_nonneg"
  CHECK ("receivedQty" >= 0);

-- You cannot receive more than you ordered. This is the DB-level backstop for
-- the lost-update race in receivePO() that the document advisory lock and the
-- atomic increment now prevent in application code.
ALTER TABLE "PurchaseOrderLine"
  ADD CONSTRAINT "PurchaseOrderLine_receivedQty_within_ordered"
  CHECK ("receivedQty" <= "quantity");
