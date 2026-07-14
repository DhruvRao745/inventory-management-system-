/**
 * Seed script — fills a fresh database with a believable demo shop,
 * so a sales demo never starts from an empty screen.
 *
 * Run with:  npx prisma db seed   (from the server folder)
 *
 * Idempotent: deletes any previous demo company first, so running it
 * twice doesn't duplicate data.
 *
 * Login after seeding:  demo@demo.com / demo1234
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const DEMO_EMAIL = "demo@demo.com";

/** n days ago, at a believable shop hour */
function daysAgo(n: number, hour = 11) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, Math.floor(Math.random() * 59), 0, 0);
  return d;
}

async function main() {
  // --- wipe previous demo company (children first, FK order) ---
  const old = await prisma.user.findFirst({ where: { email: DEMO_EMAIL } });
  if (old) {
    const companyId = old.companyId;
    await prisma.stockMovement.deleteMany({ where: { companyId } });
    await prisma.product.deleteMany({ where: { companyId } });
    await prisma.category.deleteMany({ where: { companyId } });
    await prisma.location.deleteMany({ where: { companyId } });
    await prisma.user.deleteMany({ where: { companyId } });
    await prisma.company.delete({ where: { id: companyId } });
    console.log("♻️  Removed previous demo company");
  }

  // --- company + people ---
  const company = await prisma.company.create({
    data: { name: "Demo Traders", currency: "INR" },
  });

  const passwordHash = await bcrypt.hash("demo1234", 10);
  const admin = await prisma.user.create({
    data: {
      companyId: company.id, email: DEMO_EMAIL, passwordHash,
      name: "Demo Admin", role: "ADMIN",
    },
  });
  const staff = await prisma.user.create({
    data: {
      companyId: company.id, email: "staff@demo.com", passwordHash,
      name: "Sunita Staff", role: "STAFF",
    },
  });

  // --- places ---
  const shop = await prisma.location.create({
    data: { companyId: company.id, name: "Main Shop", isDefault: true },
  });
  const godown = await prisma.location.create({
    data: { companyId: company.id, name: "Godown" },
  });

  // --- categories + products ---
  const catNames = ["Pens", "Notebooks", "Office Supplies"];
  const cats = await Promise.all(
    catNames.map((name) =>
      prisma.category.create({ data: { companyId: company.id, name } })
    )
  );

  const productDefs = [
    { sku: "PEN-BLU-01", name: "Blue Ballpoint Pen", cat: 0, cost: 5, sell: 10, low: 50, buy: 500, sales: [40, 60, 35, 80, 55] },
    { sku: "PEN-GEL-01", name: "Gel Pen Black", cat: 0, cost: 12, sell: 25, low: 30, buy: 200, sales: [15, 25, 30, 20, 18] },
    { sku: "NB-A5-100", name: "A5 Notebook 100pg", cat: 1, cost: 30, sell: 55, low: 20, buy: 150, sales: [12, 8, 15, 10, 9] },
    { sku: "NB-A4-200", name: "A4 Register 200pg", cat: 1, cost: 60, sell: 110, low: 10, buy: 80, sales: [5, 7, 4, 6, 3] },
    { sku: "STPL-01", name: "Stapler Medium", cat: 2, cost: 85, sell: 150, low: 5, buy: 40, sales: [3, 2, 4, 1, 2] },
    { sku: "PPR-A4-500", name: "A4 Paper Ream 500", cat: 2, cost: 220, sell: 320, low: 15, buy: 100, sales: [10, 14, 8, 12, 16] },
  ];

  for (const def of productDefs) {
    const product = await prisma.product.create({
      data: {
        companyId: company.id, sku: def.sku, name: def.name,
        categoryId: cats[def.cat].id, costPrice: def.cost,
        sellingPrice: def.sell, lowStockThreshold: def.low,
      },
    });

    // the opening purchase, ~2 weeks ago
    await prisma.stockMovement.create({
      data: {
        companyId: company.id, productId: product.id, locationId: shop.id,
        type: "PURCHASE", quantity: def.buy, unitCost: def.cost,
        reference: `INV-2026-${def.sku}`, createdById: admin.id,
        createdAt: daysAgo(14, 9),
      },
    });

    // a sale every few days, recorded by staff
    for (let i = 0; i < def.sales.length; i++) {
      await prisma.stockMovement.create({
        data: {
          companyId: company.id, productId: product.id, locationId: shop.id,
          type: "SALE", quantity: -def.sales[i],
          createdById: staff.id, createdAt: daysAgo(12 - i * 3, 14),
        },
      });
    }
  }

  // a transfer and an adjustment, for a realistic history
  const pen = await prisma.product.findFirst({
    where: { companyId: company.id, sku: "PEN-BLU-01" },
  });
  const transferId = crypto.randomUUID();
  await prisma.stockMovement.createMany({
    data: [
      {
        companyId: company.id, productId: pen!.id, locationId: shop.id,
        type: "TRANSFER_OUT", quantity: -100, transferId,
        createdById: admin.id, createdAt: daysAgo(7, 10),
      },
      {
        companyId: company.id, productId: pen!.id, locationId: godown.id,
        type: "TRANSFER_IN", quantity: 100, transferId,
        createdById: admin.id, createdAt: daysAgo(7, 10),
      },
    ],
  });
  await prisma.stockMovement.create({
    data: {
      companyId: company.id, productId: pen!.id, locationId: shop.id,
      type: "ADJUSTMENT", quantity: -4, note: "Damaged in storage",
      createdById: staff.id, createdAt: daysAgo(2, 17),
    },
  });

  console.log("✅ Seeded Demo Traders — login: demo@demo.com / demo1234");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
