-- P2-3: GST integrity constraints
--
-- Timestamped after 20260901044251_p2_gst (adds the columns) and after
-- 20260901050000_p2_status_constraints, so the replay order is valid.

-- Tax amounts are never negative. A negative tax component would reduce the
-- invoice total, which is not a discount — it is money reported to a
-- government as owed and then quietly taken back.
ALTER TABLE "InvoiceLine"
  ADD CONSTRAINT "line_gst_non_negative"
  CHECK (
    ("cgstAmount"   IS NULL OR "cgstAmount"   >= 0) AND
    ("sgstAmount"   IS NULL OR "sgstAmount"   >= 0) AND
    ("igstAmount"   IS NULL OR "igstAmount"   >= 0) AND
    ("taxableValue" IS NULL OR "taxableValue" >= 0)
  );

-- A GST rate is a percentage. 0 is legitimate (nil-rated goods); anything
-- above 100 or below 0 is a data-entry error, not a tax.
ALTER TABLE "InvoiceLine"
  ADD CONSTRAINT "line_gst_rate_range"
  CHECK ("gstRate" IS NULL OR ("gstRate" >= 0 AND "gstRate" <= 100));

ALTER TABLE "Product"
  ADD CONSTRAINT "product_gst_rate_range"
  CHECK ("gstRate" IS NULL OR ("gstRate" >= 0 AND "gstRate" <= 100));

-- THE ONE THAT MATTERS: a line is intra-state OR inter-state, never both.
--
-- CGST+SGST and IGST are mutually exclusive by law — the same rupee cannot be
-- reported to the centre-and-state AND as an integrated tax. A line carrying
-- both would be double-counted on filing, and the error would be invisible in
-- the total because the amounts still add up to something plausible.
ALTER TABLE "InvoiceLine"
  ADD CONSTRAINT "line_gst_split_exclusive"
  CHECK (
    COALESCE("igstAmount", 0) = 0
    OR (COALESCE("cgstAmount", 0) = 0 AND COALESCE("sgstAmount", 0) = 0)
  );
