-- P1-5 — payment integrity constraints
--
-- Added AFTER 20260826205214_payments created the table, per the rule learned
-- in P1-1 and repeated in P1-3: a hand-written migration that ALTERs a
-- Prisma-managed table can only be added once the creating migration exists
-- on disk, because `migrate dev` replays everything on a shadow database
-- before generating anything new.

-- A payment of zero is noise; a negative one is a refund, which is a
-- different business event and needs its own record rather than a
-- sign-flipped payment hiding inside the paid total.
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_amount_positive"
  CHECK ("amount" > 0);
