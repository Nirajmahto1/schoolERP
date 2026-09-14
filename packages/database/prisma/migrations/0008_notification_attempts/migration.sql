-- ──────────────────────────────────────────────
-- Retry bookkeeping (BUILD_PLAN 5.5)
--
-- The drainer increments `attempts` per failed pass; at MAX_ATTEMPTS the
-- row is DEAD_LETTERED for a human instead of silently disappearing.
-- ──────────────────────────────────────────────

ALTER TABLE "notification_logs" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "notification_logs" ADD COLUMN "lastAttemptAt" TIMESTAMP(3);
