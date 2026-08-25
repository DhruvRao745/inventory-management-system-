-- Company business details (shown on invoices)
ALTER TABLE "Company"
  ADD COLUMN "address"  TEXT,
  ADD COLUMN "phone"    TEXT,
  ADD COLUMN "email"    TEXT,
  ADD COLUMN "gstin"    TEXT,
  ADD COLUMN "pan"      TEXT,
  ADD COLUMN "sealText" TEXT;

-- Buyer GST snapshot on the invoice
ALTER TABLE "Invoice"
  ADD COLUMN "customerGstin" TEXT;
