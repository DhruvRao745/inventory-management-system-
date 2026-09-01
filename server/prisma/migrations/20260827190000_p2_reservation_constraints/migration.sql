-- P2-1: reservation integrity constraints
--
-- Timestamped AFTER 20260827181629_p2_reservations, which creates the table.
-- Prisma replays every migration in order against a shadow database, so a
-- constraint migration that runs before its table exists fails with P3006 —
-- regardless of what the file is called.

-- A reservation holds a positive amount or it holds nothing. A negative
-- reservation would ADD availability out of thin air: available = on hand −
-- reserved, so reserved = −5 quietly invents five units that do not exist.
ALTER TABLE "StockReservation"
  ADD CONSTRAINT "reservation_quantity_positive"
  CHECK ("quantity" > 0);

-- A reservation that has been consumed or released must say when. Without
-- this, "CONSUMED with no consumedAt" is representable, and the reservation
-- history stops being able to answer when a hold actually ended.
ALTER TABLE "StockReservation"
  ADD CONSTRAINT "reservation_status_timestamps"
  CHECK (
    ("status" = 'ACTIVE'   AND "consumedAt" IS NULL AND "releasedAt" IS NULL) OR
    ("status" = 'CONSUMED' AND "consumedAt" IS NOT NULL) OR
    ("status" = 'RELEASED' AND "releasedAt" IS NOT NULL)
  );

-- A hold must belong to something. An empty sourceType/sourceId is an orphan
-- hold: stock held off the shelf with nothing left to explain why, and nothing
-- that will ever release it.
ALTER TABLE "StockReservation"
  ADD CONSTRAINT "reservation_source_present"
  CHECK (length(trim("sourceType")) > 0 AND length(trim("sourceId")) > 0);
