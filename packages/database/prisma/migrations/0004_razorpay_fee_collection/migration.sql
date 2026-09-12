-- ──────────────────────────────────────────────
-- Phase 4.1: Razorpay fee collection
--
-- Two corrections surfaced by the gateway-payment work:
--   1. `payments.receiptNo` was created NOT NULL in the baseline, but the
--      Phase-2 model made it optional (`String?`) — a checkout intent exists
--      before any receipt number is minted, and the sequence runs inside the
--      capture transaction. Relax the column to match the model.
--   2. Rows written before 0002 never got receipt numbers; with the column
--      now nullable there is nothing to backfill. The unique index from 0002
--      ("payments_branchId_receiptNo_key") already allows multiple NULLs in
--      Postgres, so gateway intents and legacy rows coexist safely.
--
-- Additive/reversible per BUILD_PLAN 0.9: re-tightening is
-- `SET NOT NULL` after a one-off backfill.
-- ──────────────────────────────────────────────

ALTER TABLE "payments" ALTER COLUMN "receiptNo" DROP NOT NULL;
