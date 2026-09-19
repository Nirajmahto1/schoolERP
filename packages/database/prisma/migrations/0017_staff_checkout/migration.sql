-- ──────────────────────────────────────────────
-- Staff check-out (Phase: arrival + departure marking).
-- The first self-mark of the day is the arrival (markedAt), a second
-- self-mark records the departure (checkoutAt). Both are server clock.
-- ──────────────────────────────────────────────

ALTER TABLE "staff_attendances"
  ADD COLUMN IF NOT EXISTS "checkoutAt" TIMESTAMP(3);
