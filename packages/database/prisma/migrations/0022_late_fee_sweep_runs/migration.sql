-- ──────────────────────────────────────────────
-- Late-fee sweep run history (audit)
--
-- One row per apply pass — nightly scheduler (source NIGHTLY) or a manual
-- console click (source MANUAL) — with the per-fine report in details JSON
-- so admins can reconstruct exactly what was fined, by which rule, and when.
-- FAILURE rows replace a thrown error with a durable audit trail.
-- ──────────────────────────────────────────────

CREATE TABLE "late_fee_sweep_runs" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "scanned" INTEGER NOT NULL DEFAULT 0,
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "details" JSONB,
    "errorMessage" TEXT,
    "durationMs" INTEGER,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "late_fee_sweep_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "late_fee_sweep_runs_branchId_createdAt_idx" ON "late_fee_sweep_runs"("branchId", "createdAt");
ALTER TABLE "late_fee_sweep_runs" ADD CONSTRAINT "late_fee_sweep_runs_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
