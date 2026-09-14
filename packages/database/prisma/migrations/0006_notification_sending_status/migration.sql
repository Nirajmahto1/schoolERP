-- ──────────────────────────────────────────────
-- Dispatcher claim state (BUILD_PLAN 5.5)
--
-- The unified dispatcher claims QUEUED rows by flipping them to SENDING
-- before it talks to providers — the conditional update is the idempotency
-- boundary that keeps two concurrent drainers from double-sending (and
-- double-charging credits). SENDING is transient: every row leaves it as
-- SENT (provider accepted), FAILED (chain exhausted), or QUEUED again
-- (quiet-hours deferral).
-- ──────────────────────────────────────────────

ALTER TYPE "NotificationStatus" ADD VALUE IF NOT EXISTS 'SENDING';
