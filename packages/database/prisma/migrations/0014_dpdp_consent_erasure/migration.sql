-- ──────────────────────────────────────────────
-- DPDP Act 2023 scaffolding (BUILD_PLAN 10.1)
--
-- Verifiable parental consent records (per child × purpose, capture
-- method + evidence + withdrawal path) and data-principal erasure
-- requests (PENDING → COMPLETED/REJECTED, with the resolution note
-- recording what statutory-retention rules kept). The routes audit-log
-- every transition; these tables carry the lifecycle, the audit trail
-- carries the proof.
-- ──────────────────────────────────────────────

CREATE TYPE "ConsentStatus" AS ENUM ('GRANTED', 'WITHDRAWN');

CREATE TABLE "consent_records" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "guardianId" TEXT,
    "purpose" TEXT NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "grantedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "method" TEXT NOT NULL,
    "evidence" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "consent_records_studentId_purpose_key" ON "consent_records"("studentId", "purpose");
CREATE INDEX "consent_records_branchId_studentId_idx" ON "consent_records"("branchId", "studentId");

ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TYPE "ErasureStatus" AS ENUM ('PENDING', 'COMPLETED', 'REJECTED');

CREATE TABLE "erasure_requests" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "reason" TEXT,
    "status" "ErasureStatus" NOT NULL DEFAULT 'PENDING',
    "processedBy" TEXT,
    "processedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "erasure_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "erasure_requests_branchId_status_idx" ON "erasure_requests"("branchId", "status");

ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
