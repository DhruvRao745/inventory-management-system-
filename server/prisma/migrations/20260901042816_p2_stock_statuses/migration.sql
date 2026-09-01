/*
  Warnings:

  - A unique constraint covering the columns `[companyId,productId,locationId,batchNumber,status]` on the table `InventoryBatch` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "StockStatus" AS ENUM ('AVAILABLE', 'DAMAGED', 'QUARANTINE', 'EXPIRED');

-- DropIndex
DROP INDEX "InventoryBatch_companyId_productId_locationId_batchNumber_key";

-- AlterTable
ALTER TABLE "InventoryBatch" ADD COLUMN     "status" "StockStatus" NOT NULL DEFAULT 'AVAILABLE';

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "status" "StockStatus" NOT NULL DEFAULT 'AVAILABLE';

-- CreateIndex
CREATE INDEX "InventoryBatch_companyId_productId_locationId_status_expiry_idx" ON "InventoryBatch"("companyId", "productId", "locationId", "status", "expiryDate");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryBatch_companyId_productId_locationId_batchNumber_s_key" ON "InventoryBatch"("companyId", "productId", "locationId", "batchNumber", "status");

-- CreateIndex
CREATE INDEX "StockMovement_companyId_productId_locationId_status_idx" ON "StockMovement"("companyId", "productId", "locationId", "status");
