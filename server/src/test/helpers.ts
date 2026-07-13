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
  await prisma.stockMovement.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
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
