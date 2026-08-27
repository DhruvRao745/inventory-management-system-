-- AlterTable
ALTER TABLE "InvoiceLine" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(18,4);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "packUnit" TEXT,
ADD COLUMN     "precision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "unitsPerPack" DECIMAL(18,4),
ALTER COLUMN "lowStockThreshold" SET DEFAULT 0,
ALTER COLUMN "lowStockThreshold" SET DATA TYPE DECIMAL(18,4);

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(18,4),
ALTER COLUMN "receivedQty" SET DEFAULT 0,
ALTER COLUMN "receivedQty" SET DATA TYPE DECIMAL(18,4);

-- AlterTable
ALTER TABLE "StockMovement" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(18,4);
