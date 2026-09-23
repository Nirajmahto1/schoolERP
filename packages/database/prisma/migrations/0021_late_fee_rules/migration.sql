-- ──────────────────────────────────────────────
-- Late-fee rules (Phase: fee collection)
--
-- Per-branch slabs: "15 days overdue → ₹50, 30 days → ₹200". A rule matches
-- when (daysOverdue >= minDays) AND (maxDays IS NULL OR daysOverdue <= maxDays).
-- Percent rules compute on the invoice outstanding at apply time; flat rules
-- take amount as-is. Application is idempotent per (invoice, rule, slab-day)
-- via the ledger reference — re-running never double-fines.
-- ──────────────────────────────────────────────

CREATE TABLE "late_fee_rules" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "minDays" INTEGER NOT NULL,
    "maxDays" INTEGER,
    "amount" DECIMAL(12,2) NOT NULL,
    "isPercent" BOOLEAN NOT NULL DEFAULT false,
    "feeHeadId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "late_fee_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "late_fee_rules_branchId_idx" ON "late_fee_rules"("branchId");
ALTER TABLE "late_fee_rules" ADD CONSTRAINT "late_fee_rules_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "late_fee_rules" ADD CONSTRAINT "late_fee_rules_feeHeadId_fkey" FOREIGN KEY ("feeHeadId") REFERENCES "fee_heads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
