/**
 * Test helpers — the props department for our robot customers.
 *
 * resetDb(): wipes every table so each test starts from a blank shop.
 *   Order matters: children first (movements point at products, etc.),
 *   parents last — otherwise foreign keys refuse the delete.
 *
 * createTestCompany(): builds a ready-made fixture — company, admin
 *   user, location, product — so each test doesn't repeat 20 lines.
 */
import { prisma } from "../lib/prisma.js";

export async function resetDb() {
  // Children first, parents last — foreign keys refuse the delete otherwise.
  // Invoice/PO lines cascade from their headers, but we delete them explicitly
  // so the order stays obvious and doesn't depend on cascade rules.
  await prisma.stockCountItem.deleteMany();
  await prisma.stockCount.deleteMany();
  await prisma.productLocationSetting.deleteMany();
  await prisma.supplierReturnLine.deleteMany();
  await prisma.supplierReturn.deleteMany();
  await prisma.goodsReceiptLine.deleteMany();
  await prisma.goodsReceipt.deleteMany();
  await prisma.salesReturnLine.deleteMany();
  await prisma.salesReturn.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.invoiceLine.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.purchaseOrderLine.deleteMany();
  await prisma.purchaseOrder.deleteMany();
  // Batch allocations point at BOTH movements and batches, so they go first.
  await prisma.stockMovementBatch.deleteMany();
  await prisma.inventoryBatch.deleteMany();
  await prisma.stockMovement.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.location.deleteMany();
  await prisma.user.deleteMany();
  await prisma.company.deleteMany();
}

export async function createTestCompany(name = "Test Co") {
  const company = await prisma.company.create({ data: { name } });
  const user = await prisma.user.create({
    data: {
      companyId: company.id,
      email: `admin@${name.toLowerCase().replace(/\s/g, "")}.test`,
      passwordHash: "not-a-real-hash",
      name: "Test Admin",
      role: "ADMIN",
    },
  });
  const location = await prisma.location.create({
    data: { companyId: company.id, name: "Main", isDefault: true },
  });
  const product = await prisma.product.create({
    data: {
      companyId: company.id,
      sku: "TEST-001",
      name: "Test Widget",
      costPrice: 10,
      sellingPrice: 20,
      lowStockThreshold: 5,
    },
  });
  return { company, user, location, product };
}
