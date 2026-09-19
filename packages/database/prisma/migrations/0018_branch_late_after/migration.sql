-- ──────────────────────────────────────────────
-- Late-arrival cutoff (Phase: late detection).
-- branches.lateAfterMinutes = minutes past midnight in the branch's local
-- time (Asia/Kolkata) after which a self-check-in counts as LATE. NULL
-- disables the check (every check-in is PRESENT).
-- ──────────────────────────────────────────────

ALTER TABLE "branches"
  ADD COLUMN IF NOT EXISTS "lateAfterMinutes" INTEGER;

-- Existing single-campus deployments keep current behavior (NULL = off).
