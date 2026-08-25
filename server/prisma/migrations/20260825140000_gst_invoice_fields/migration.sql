-- Per-item HSN/SAC tax code (GST invoices)
ALTER TABLE "Product" ADD COLUMN "hsnCode" TEXT;

-- Terms & conditions printed on invoices
ALTER TABLE "Company" ADD COLUMN "invoiceTerms" TEXT;
