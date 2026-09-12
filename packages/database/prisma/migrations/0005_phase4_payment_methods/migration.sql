-- ──────────────────────────────────────────────
-- Phase 4: payment methods and receipt storage (BUILD_PLAN 4.1.3 / 4.1.8 / 4.1.4)
--
--   cheque_payments        — instrument tracking incl. deposit + bounce
--   bank_deposits          — cash/cheque bank-deposit slips
--   virtual_accounts       — NEFT virtual account per student (4.1.3)
--   payments.receiptPdf    — rendered PDF bytes (NULL until rendered)
--
-- Tenant-DB only: the SaaS-billing columns live in the CONTROL-PLANE
-- migration 0001 (different database — tenants, saas_invoices, usage,
-- dunning). Additive only, reversible by DROP.
-- ──────────────────────────────────────────────

-- ── Cheque payments (4.1.3 / 4.1.8) ──
CREATE TYPE "ChequeStatus" AS ENUM ('RECEIVED', 'DEPOSITED', 'CREDITED', 'BOUNCED', 'RETURNED_TO_PARENT');

CREATE TABLE "cheque_payments" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "chequeNumber" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "branchName" TEXT,
    "drawerName" TEXT,
    "chequeDate" TIMESTAMP(3) NOT NULL,
    "status" "ChequeStatus" NOT NULL DEFAULT 'RECEIVED',
    "depositedAt" TIMESTAMP(3),
    "bankDepositId" TEXT,
    "bounceReason" TEXT,
    "bouncedAt" TIMESTAMP(3),
    "penaltyLedgerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cheque_payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cheque_payments_paymentId_key" ON "cheque_payments"("paymentId");
CREATE INDEX "cheque_payments_branchId_status_idx" ON "cheque_payments"("branchId", "status");
CREATE INDEX "cheque_payments_chequeNumber_idx" ON "cheque_payments"("chequeNumber");

-- ── Bank deposits (4.1.3: cash/cheque entry with bank-deposit tracking) ──
CREATE TABLE "bank_deposits" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "depositSlipNo" TEXT NOT NULL,
    "depositedAt" TIMESTAMP(3) NOT NULL,
    "totalCash" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalCheques" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "bankName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PREPARED',
    "creditedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_deposits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bank_deposits_branchId_depositSlipNo_key" ON "bank_deposits"("branchId", "depositSlipNo");
CREATE INDEX "bank_deposits_branchId_depositedAt_idx" ON "bank_deposits"("branchId", "depositedAt");

ALTER TABLE "cheque_payments" ADD CONSTRAINT "cheque_payments_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cheque_payments" ADD CONSTRAINT "cheque_payments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cheque_payments" ADD CONSTRAINT "cheque_payments_bankDepositId_fkey" FOREIGN KEY ("bankDepositId") REFERENCES "bank_deposits"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bank_deposits" ADD CONSTRAINT "bank_deposits_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── NEFT virtual accounts (4.1.3: large schools want per-student VA) ──
CREATE TABLE "virtual_accounts" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'RAZORPAY',
    "accountNumber" TEXT NOT NULL,
    "ifsc" TEXT NOT NULL,
    "beneficiaryName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "virtual_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "virtual_accounts_branchId_accountNumber_key" ON "virtual_accounts"("branchId", "accountNumber");
CREATE UNIQUE INDEX "virtual_accounts_studentId_key" ON "virtual_accounts"("studentId");
ALTER TABLE "virtual_accounts" ADD CONSTRAINT "virtual_accounts_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "virtual_accounts" ADD CONSTRAINT "virtual_accounts_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Receipt PDF storage (4.1.4) ──
ALTER TABLE "payments" ADD COLUMN "receiptPdf" TEXT;

-- SaaS billing columns (tenants.gstin, saas_invoices numbering/GST,
-- usage_records, dunning_events) live in control-plane migration 0001.
