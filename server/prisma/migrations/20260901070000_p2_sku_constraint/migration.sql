-- P2-6 follow-up: a product must have a SKU.
--
-- FOUND BY A TEST, not by a bug report. A test calling productService
-- .updateProduct directly saved a product with sku = "". The API path is safe
-- — the route's Zod schema enforces min(1) — but the service trusts whatever
-- it is handed, and nothing in the database disagreed.
--
-- That gap matters the first time something writes products by another route:
-- a CSV import, a data migration, a future bulk-edit endpoint. The SKU is the
-- code on the label and half of the (companyId, sku) unique key; a blank one
-- leaves a product with no identifier at all.
--
-- IF THIS MIGRATION FAILS, a row already violates it. Find the offenders with:
--
--   SELECT id, name, "companyId" FROM "Product" WHERE length(trim(sku)) = 0;
--
-- and give each a real SKU before re-running. It is deliberately NOT
-- auto-corrected here: inventing a SKU for someone else's product would be
-- silently rewriting data that a human should look at.

ALTER TABLE "Product"
  ADD CONSTRAINT "product_sku_not_blank"
  CHECK (length(trim("sku")) > 0);
