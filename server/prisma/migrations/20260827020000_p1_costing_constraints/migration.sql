-- P1-3 — costing integrity constraints
--
-- Must sort AFTER the Prisma-generated migration that adds Product.avgCost,
-- Product.stockValue and StockMovement.costAtTime. (Lesson from P1-1: a
-- hand-written migration cannot ALTER a table an earlier migration hasn't
-- created yet — `migrate dev` replays everything on a shadow database before
-- generating anything new.)
--
-- Same principle as P0/P1-1: the application already enforces these. This is
-- the layer that catches the day a new code path forgets.

-- Stock cannot be worth a negative amount. An empty shelf is worth zero; a
-- negative asset value would poison every valuation and profit figure
-- downstream, and would be very hard to trace back to its cause.
ALTER TABLE "Product"
  ADD CONSTRAINT "Product_stockValue_nonneg"
  CHECK ("stockValue" >= 0);

-- Nor can a unit have cost a negative amount.
ALTER TABLE "Product"
  ADD CONSTRAINT "Product_avgCost_nonneg"
  CHECK ("avgCost" >= 0);

-- The cost stamped on a movement is optional (transfers carry none), but when
-- present it can never be negative — that would invert COGS and turn a sale
-- into a profit centre by arithmetic accident.
ALTER TABLE "StockMovement"
  ADD CONSTRAINT "StockMovement_costAtTime_nonneg"
  CHECK ("costAtTime" IS NULL OR "costAtTime" >= 0);
