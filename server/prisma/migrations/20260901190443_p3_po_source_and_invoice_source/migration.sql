-- CreateEnum
CREATE TYPE "InvoiceSource" AS ENUM ('MANUAL', 'POS');

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "source" "InvoiceSource" NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "generatedFrom" TEXT;
