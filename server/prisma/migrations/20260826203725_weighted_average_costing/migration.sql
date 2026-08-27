-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "avgCost" DECIMAL(18,6) NOT NULL DEFAULT 0,
ADD COLUMN     "stockValue" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "costAtTime" DECIMAL(18,6);
