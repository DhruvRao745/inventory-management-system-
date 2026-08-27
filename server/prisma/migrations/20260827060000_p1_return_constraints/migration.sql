-- P1-6 — sales return integrity constraints
--
-- Added AFTER 20260827055526_sales_returns created the tables. Note the
-- timestamp is later than that migration, not merely later than the other
-- constraint files — ordering is by folder name across the WHOLE directory.

-- Returning zero of something is not an event.
ALTER TABLE "SalesReturnLine"
  ADD CONSTRAINT "SalesReturnLine_quantity_positive"
  CHECK ("quantity" > 0);

-- THE rule of this feature, at the database level (PRD §9): only goods in
-- sellable condition may ever go back into available stock. The service
-- refuses it and so does Zod; this is the layer that catches the day someone
-- writes a new code path and forgets.
ALTER TABLE "SalesReturnLine"
  ADD CONSTRAINT "SalesReturnLine_only_sellable_restocks"
  CHECK ("restock" = false OR "condition" = 'SELLABLE');

-- A refund of a negative amount is a sale, not a refund.
ALTER TABLE "SalesReturn"
  ADD CONSTRAINT "SalesReturn_refundAmount_nonneg"
  CHECK ("refundAmount" IS NULL OR "refundAmount" >= 0);
