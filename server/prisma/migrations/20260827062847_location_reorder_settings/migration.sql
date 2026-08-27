-- CreateTable
CREATE TABLE "ProductLocationSetting" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "minQuantity" DECIMAL(18,4),
    "maxQuantity" DECIMAL(18,4),
    "reorderQuantity" DECIMAL(18,4),
    "preferredSupplierId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductLocationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductLocationSetting_companyId_idx" ON "ProductLocationSetting"("companyId");

-- CreateIndex
CREATE INDEX "ProductLocationSetting_companyId_locationId_idx" ON "ProductLocationSetting"("companyId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductLocationSetting_companyId_productId_locationId_key" ON "ProductLocationSetting"("companyId", "productId", "locationId");

-- AddForeignKey
ALTER TABLE "ProductLocationSetting" ADD CONSTRAINT "ProductLocationSetting_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductLocationSetting" ADD CONSTRAINT "ProductLocationSetting_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductLocationSetting" ADD CONSTRAINT "ProductLocationSetting_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductLocationSetting" ADD CONSTRAINT "ProductLocationSetting_preferredSupplierId_fkey" FOREIGN KEY ("preferredSupplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
