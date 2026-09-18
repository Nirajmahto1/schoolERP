-- ──────────────────────────────────────────────
-- Student certificates (BUILD_PLAN 10.3 #4)
--
-- "Certificates: Transfer Certificate (numbered, board-specific wording),
-- bonafide, character, migration, fee-payment certificate, ID cards, admit
-- cards. Small feature, constant demand."
--
-- TC already has its own table (issuing one closes the enrollment — a
-- workflow, not just a document). Every other certificate is an immutable,
-- numbered snapshot row: the PDF renders from `payload`, stamped at issue,
-- so a later edit of the student record never silently rewrites an
-- already-issued document — the same reason receipts snapshot the payment.
-- ──────────────────────────────────────────────

CREATE TYPE "CertificateType" AS ENUM ('BONAFIDE', 'CHARACTER', 'FEE_CERTIFICATE', 'ID_CARD', 'ADMIT_CARD');

CREATE TABLE "student_certificates" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "type" "CertificateType" NOT NULL,
    "certNo" TEXT NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purpose" TEXT,
    "payload" JSONB NOT NULL,
    "issuedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_certificates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "student_certificates_branchId_type_certNo_key" ON "student_certificates"("branchId", "type", "certNo");
CREATE INDEX "student_certificates_branchId_studentId_idx" ON "student_certificates"("branchId", "studentId");

ALTER TABLE "student_certificates" ADD CONSTRAINT "student_certificates_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "student_certificates" ADD CONSTRAINT "student_certificates_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
