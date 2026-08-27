-- CreateEnum
CREATE TYPE "BatchStrategy" AS ENUM ('FEFO', 'FIFO');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "batchStrategy" "BatchStrategy" NOT NULL DEFAULT 'FEFO';

-- CreateTable
CREATE TABLE "InventoryBatch" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "manufactureDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "unitCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "receivedQuantity" DECIMAL(18,4) NOT NULL,
    "remainingQuantity" DECIMAL(18,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovementBatch" (
    "id" TEXT NOT NULL,
    "movementId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "StockMovementBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryBatch_companyId_productId_locationId_expiryDate_idx" ON "InventoryBatch"("companyId", "productId", "locationId", "expiryDate");

-- CreateIndex
CREATE INDEX "InventoryBatch_companyId_idx" ON "InventoryBatch"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryBatch_companyId_productId_locationId_batchNumber_key" ON "InventoryBatch"("companyId", "productId", "locationId", "batchNumber");

-- CreateIndex
CREATE INDEX "StockMovementBatch_movementId_idx" ON "StockMovementBatch"("movementId");

-- CreateIndex
CREATE INDEX "StockMovementBatch_batchId_idx" ON "StockMovementBatch"("batchId");

-- AddForeignKey
ALTER TABLE "InventoryBatch" ADD CONSTRAINT "InventoryBatch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryBatch" ADD CONSTRAINT "InventoryBatch_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryBatch" ADD CONSTRAINT "InventoryBatch_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovementBatch" ADD CONSTRAINT "StockMovementBatch_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "StockMovement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovementBatch" ADD CONSTRAINT "StockMovementBatch_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "InventoryBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
