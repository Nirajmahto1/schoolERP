-- ──────────────────────────────────────────────
-- Phase 10.2: government identifiers and reporting fields.
--   • schools.udise_code + schools.board — the UDISE+ return and the LOC
--     export key off these.
--   • students.apaar_id — APAAR/ABC unique student ID (unique per branch when
--     present), students.rte_quota — the 25% quota seat flag.
-- Nullable/columns-with-defaults only: no backfill needed.
-- ──────────────────────────────────────────────

ALTER TABLE "schools" ADD COLUMN "udiseCode" TEXT;
ALTER TABLE "schools" ADD COLUMN "board" TEXT;
CREATE UNIQUE INDEX "schools_udiseCode_key" ON "schools"("udiseCode");

ALTER TABLE "students" ADD COLUMN "apaarId" TEXT;
ALTER TABLE "students" ADD COLUMN "rteQuota" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "students_branchId_apaarId_key" ON "students"("branchId", "apaarId");
