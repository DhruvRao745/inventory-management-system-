-- P1-7 — goods receipt + supplier return constraints
--
-- Added AFTER 20260827061757_goods_receipts_supplier_returns created the
-- tables, with a LATER timestamp than that generated folder.

-- A delivery of nothing is not a delivery. Accepted may be zero (everything
-- was rejected), but the line must record SOMETHING arriving.
ALTER TABLE "GoodsReceiptLine"
  ADD CONSTRAINT "GoodsReceiptLine_something_arrived"
  CHECK ("acceptedQty" > 0 OR "rejectedQty" > 0);

ALTER TABLE "GoodsReceiptLine"
  ADD CONSTRAINT "GoodsReceiptLine_accepted_nonneg"
  CHECK ("acceptedQty" >= 0);

ALTER TABLE "GoodsReceiptLine"
  ADD CONSTRAINT "GoodsReceiptLine_rejected_nonneg"
  CHECK ("rejectedQty" >= 0);

-- Being charged a negative amount is a credit note, not a delivery.
ALTER TABLE "GoodsReceiptLine"
  ADD CONSTRAINT "GoodsReceiptLine_actualUnitCost_nonneg"
  CHECK ("actualUnitCost" >= 0);

ALTER TABLE "SupplierReturnLine"
  ADD CONSTRAINT "SupplierReturnLine_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "SupplierReturnLine"
  ADD CONSTRAINT "SupplierReturnLine_unitCost_nonneg"
  CHECK ("unitCost" >= 0);
