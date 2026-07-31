/*
  Warnings:

  - A unique constraint covering the columns `[companyId,barcode]` on the table `Product` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "barcode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Product_companyId_barcode_key" ON "Product"("companyId", "barcode");
