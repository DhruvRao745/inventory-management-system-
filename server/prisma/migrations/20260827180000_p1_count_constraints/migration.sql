-- P1-9 — stock count constraints
--
-- Added AFTER 20260827170220_stock_counts created the tables, with a later
-- timestamp than that generated folder.

-- Expected and counted quantities can be zero (an empty shelf is a real
-- finding) but never negative — you cannot physically count minus three.
ALTER TABLE "StockCountItem"
  ADD CONSTRAINT "StockCountItem_expected_nonneg"
  CHECK ("expectedQuantity" >= 0);

ALTER TABLE "StockCountItem"
  ADD CONSTRAINT "StockCountItem_counted_nonneg"
  CHECK ("countedQuantity" IS NULL OR "countedQuantity" >= 0);
