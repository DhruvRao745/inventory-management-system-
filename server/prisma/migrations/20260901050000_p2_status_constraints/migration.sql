-- P2-2: stock status constraints
--
-- Timestamped AFTER 20260901042816_p2_stock_statuses, which adds the `status`
-- columns. Prisma replays every migration in order against a shadow database,
-- so a constraint referencing a column no earlier migration has created fails
-- with P3006 regardless of the file name.

-- A batch's remaining quantity can never exceed what was received, whatever
-- condition it is in. This held implicitly before; statuses split lots across
-- more rows, so it is worth stating explicitly.
ALTER TABLE "InventoryBatch"
  ADD CONSTRAINT "batch_remaining_within_received"
  CHECK ("remainingQuantity" <= "receivedQuantity");

-- NOT ENFORCEABLE HERE, recorded so the reasoning isn't lost:
--
-- "A reservation may only point at sellable stock" spans two tables
-- (StockReservation and StockMovement), which a CHECK constraint cannot
-- express. It is enforced in lib/reservations.ts, where availability is
-- computed from AVAILABLE movements only — so reserving against damaged or
-- quarantined stock is impossible by construction rather than by rule.
