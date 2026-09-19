-- ──────────────────────────────────────────────
-- Late-arrival minutes as data (Phase: monthly LATE tally).
-- The check-in stores how many minutes past the branch cutoff it landed;
-- remarks stay human-readable, but the tally aggregates the number.
-- ──────────────────────────────────────────────

ALTER TABLE "staff_attendances"
  ADD COLUMN IF NOT EXISTS "lateMinutes" INTEGER;
