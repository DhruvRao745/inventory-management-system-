-- P1-1 — batch integrity constraints
--
-- Run AFTER the Prisma-generated migration that creates InventoryBatch and
-- StockMovementBatch. Same principle as the P0 constraints: application code
-- and the advisory lock already enforce these, and this is the layer that
-- catches the day someone adds a code path that forgets.
--
-- The batch equivalent of "stock can never go negative" is "a lot can never
-- have less than none left", and it is exactly as important — a negative
-- remainingQuantity would mean we shipped units that never existed.

-- A lot can never owe stock.
ALTER TABLE "InventoryBatch"
  ADD CONSTRAINT "InventoryBatch_remainingQuantity_nonneg"
  CHECK ("remainingQuantity" >= 0);

-- Nor can it have been received in negative amounts.
ALTER TABLE "InventoryBatch"
  ADD CONSTRAINT "InventoryBatch_receivedQuantity_positive"
  CHECK ("receivedQuantity" > 0);

-- You cannot have more left than ever arrived. This is the batch-level twin of
-- PurchaseOrderLine_receivedQty_within_ordered: it catches a restore/return
-- path that puts back more than it took.
ALTER TABLE "InventoryBatch"
  ADD CONSTRAINT "InventoryBatch_remaining_within_received"
  CHECK ("remainingQuantity" <= "receivedQuantity");

ALTER TABLE "InventoryBatch"
  ADD CONSTRAINT "InventoryBatch_unitCost_nonneg"
  CHECK ("unitCost" >= 0);

-- An expiry before its manufacture date is a data-entry error, not a product.
ALTER TABLE "InventoryBatch"
  ADD CONSTRAINT "InventoryBatch_expiry_after_manufacture"
  CHECK (
    "manufactureDate" IS NULL
    OR "expiryDate" IS NULL
    OR "expiryDate" >= "manufactureDate"
  );

-- An allocation of zero is meaningless noise, same rule as StockMovement.
ALTER TABLE "StockMovementBatch"
  ADD CONSTRAINT "StockMovementBatch_quantity_nonzero"
  CHECK ("quantity" <> 0);
