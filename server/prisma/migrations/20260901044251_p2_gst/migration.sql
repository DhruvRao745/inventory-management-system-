-- CreateEnum
CREATE TYPE "TaxMode" AS ENUM ('FLAT', 'GST');

-- CreateEnum
CREATE TYPE "SupplyType" AS ENUM ('INTRA_STATE', 'INTER_STATE');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "stateCode" TEXT;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "gstin" TEXT,
ADD COLUMN     "stateCode" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "placeOfSupply" TEXT,
ADD COLUMN     "supplyType" "SupplyType",
ADD COLUMN     "taxMode" "TaxMode" NOT NULL DEFAULT 'FLAT';

-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN     "cgstAmount" DECIMAL(12,2),
ADD COLUMN     "gstRate" DECIMAL(5,2),
ADD COLUMN     "hsnCode" TEXT,
ADD COLUMN     "igstAmount" DECIMAL(12,2),
ADD COLUMN     "sgstAmount" DECIMAL(12,2),
ADD COLUMN     "taxableValue" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "gstRate" DECIMAL(5,2);
