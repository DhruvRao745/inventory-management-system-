-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "tracksBatch" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "batchNumber" TEXT,
ADD COLUMN     "expiryDate" TIMESTAMP(3);
