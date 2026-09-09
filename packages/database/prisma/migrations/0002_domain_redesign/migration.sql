-- ─────────────────────────────────────────────────────────────
-- Phase 2.2–2.7 — Domain model redesign
--
-- BUILD_PLAN 2.8 rule: additive → backfill → remove, so the migration is
-- reversible against a live school and never deletes before the new shape
-- holds the data. The old `attendances`, `fee_items`, `fee_invoices` and the
-- legacy `FeeStatus` enum are dropped only AFTER their rows are re-homed.
--
--   1. new enums
--   2. new tables
--   3. additive columns on existing tables
--   4. backfill (fee heads → structures → invoices → payments → ledger →
--      enrollments → attendance → exam workflow → grading → sequences)
--   5. remove legacy columns/tables/enums
--   6. new indexes (incl. the partial unique index for one current year)

BEGIN;

-- ── 1. New enums ──
CREATE TYPE "EnrollmentStatus" AS ENUM ('ENROLLED', 'PROMOTED', 'DETAINED', 'TC_ISSUED', 'LEFT');
CREATE TYPE "TermType" AS ENUM ('TERM', 'SEMESTER');
CREATE TYPE "CalendarEntryType" AS ENUM ('WORKING_DAY', 'HOLIDAY', 'EVENT', 'EXAM_WINDOW');
CREATE TYPE "HolidayType" AS ENUM ('NATIONAL', 'REGIONAL', 'SCHOOL', 'EXAM', 'OTHER');
CREATE TYPE "PromotionBatchStatus" AS ENUM ('EXECUTED', 'REVERSED');
CREATE TYPE "StudentLeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE "FeeHeadType" AS ENUM ('TUITION', 'TRANSPORT', 'ADMISSION', 'EXAM', 'LAB', 'ANNUAL', 'DEVELOPMENT', 'LATE_FEE', 'MISCELLANEOUS', 'OTHER');
CREATE TYPE "FeeFrequency" AS ENUM ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY', 'ONE_TIME');
CREATE TYPE "ConcessionCategory" AS ENUM ('SCHOLARSHIP', 'SIBLING_DISCOUNT', 'STAFF_WARD', 'RTE', 'MERIT', 'NEED_BASED', 'OTHER');
CREATE TYPE "ConcessionType" AS ENUM ('PERCENTAGE', 'FLAT');
CREATE TYPE "ConcessionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');
CREATE TYPE "FeeLedgerType" AS ENUM ('DEMAND', 'PAYMENT', 'CONCESSION', 'LATE_FEE', 'ADJUSTMENT', 'REFUND', 'WRITE_OFF');
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID', 'CANCELLED', 'WAIVED');
CREATE TYPE "PaymentStatus" AS ENUM ('INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'REFUNDED', 'DISPUTED');
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CHEQUE', 'UPI', 'ONLINE', 'NEFT', 'CARD', 'BANK_TRANSFER', 'OTHER');
CREATE TYPE "PaymentAllocationMode" AS ENUM ('OLDEST_DUES_FIRST', 'HEAD_PRIORITY', 'MANUAL');
CREATE TYPE "ExamStatus" AS ENUM ('ENTRY', 'SUBMITTED', 'VERIFIED', 'PUBLISHED');
CREATE TYPE "DocumentType" AS ENUM ('BIRTH_CERTIFICATE', 'AADHAAR', 'TC', 'CASTE_CERTIFICATE', 'PHOTO', 'MEDICAL', 'ID_PROOF', 'ADDRESS_PROOF', 'REPORT_CARD', 'OTHER');
CREATE TYPE "VirusScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'ERROR');
CREATE TYPE "NotificationChannel" AS ENUM ('SMS', 'EMAIL', 'WHATSAPP', 'PUSH', 'IN_APP');
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'DEAD_LETTERED');

-- AttendanceStatus is reused and extended (2.4.3): medical + excused.
ALTER TYPE "AttendanceStatus" ADD VALUE IF NOT EXISTS 'MEDICAL';
ALTER TYPE "AttendanceStatus" ADD VALUE IF NOT EXISTS 'EXCUSED';

-- ── 2. New tables ──

CREATE TABLE "terms" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "type" "TermType" NOT NULL DEFAULT 'TERM',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "terms_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "terms_academicYearId_name_key" ON "terms"("academicYearId", "name");
ALTER TABLE "terms" ADD CONSTRAINT "terms_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "academic_calendar" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "type" "CalendarEntryType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "classId" TEXT,
    "isWorkingDay" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "academic_calendar_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "academic_calendar_branchId_date_idx" ON "academic_calendar"("branchId", "date");
CREATE INDEX "academic_calendar_academicYearId_idx" ON "academic_calendar"("academicYearId");
ALTER TABLE "academic_calendar" ADD CONSTRAINT "academic_calendar_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "academic_calendar" ADD CONSTRAINT "academic_calendar_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON UPDATE CASCADE;
ALTER TABLE "academic_calendar" ADD CONSTRAINT "academic_calendar_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "holidays" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "type" "HolidayType" NOT NULL DEFAULT 'SCHOOL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "holidays_branchId_date_key" ON "holidays"("branchId", "date");
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON UPDATE CASCADE;

CREATE TABLE "student_enrollments" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "rollNo" TEXT,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ENROLLED',
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3),
    "promotionBatchId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "student_enrollments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "student_enrollments_studentId_academicYearId_key" ON "student_enrollments"("studentId", "academicYearId");
CREATE INDEX "student_enrollments_branchId_academicYearId_idx" ON "student_enrollments"("branchId", "academicYearId");
CREATE INDEX "student_enrollments_classId_sectionId_idx" ON "student_enrollments"("classId", "sectionId");
CREATE INDEX "student_enrollments_status_idx" ON "student_enrollments"("status");
ALTER TABLE "student_enrollments" ADD CONSTRAINT "student_enrollments_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "student_enrollments" ADD CONSTRAINT "student_enrollments_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON UPDATE CASCADE;
ALTER TABLE "student_enrollments" ADD CONSTRAINT "student_enrollments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON UPDATE CASCADE;
ALTER TABLE "student_enrollments" ADD CONSTRAINT "student_enrollments_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON UPDATE CASCADE;
ALTER TABLE "student_enrollments" ADD CONSTRAINT "student_enrollments_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON UPDATE CASCADE;

CREATE TABLE "promotion_batches" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "fromAcademicYearId" TEXT NOT NULL,
    "toAcademicYearId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "sectionId" TEXT,
    "status" "PromotionBatchStatus" NOT NULL DEFAULT 'EXECUTED',
    "stats" JSONB NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedBy" TEXT,
    CONSTRAINT "promotion_batches_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "promotion_batches_branchId_createdAt_idx" ON "promotion_batches"("branchId", "createdAt");
ALTER TABLE "promotion_batches" ADD CONSTRAINT "promotion_batches_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON UPDATE CASCADE;
ALTER TABLE "promotion_batches" ADD CONSTRAINT "promotion_batches_fromAcademicYearId_fkey" FOREIGN KEY ("fromAcademicYearId") REFERENCES "academic_years"("id") ON UPDATE CASCADE;
ALTER TABLE "promotion_batches" ADD CONSTRAINT "promotion_batches_toAcademicYearId_fkey" FOREIGN KEY ("toAcademicYearId") REFERENCES "academic_years"("id") ON UPDATE CASCADE;
ALTER TABLE "promotion_batches" ADD CONSTRAINT "promotion_batches_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON UPDATE CASCADE;

CREATE TABLE "subject_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "subject_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "subject_groups_classId_name_key" ON "subject_groups"("classId", "name");
ALTER TABLE "subject_groups" ADD CONSTRAINT "subject_groups_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subject_groups" ADD CONSTRAINT "subject_groups_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON UPDATE CASCADE;

CREATE TABLE "student_subjects" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "isOptional" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "student_subjects_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "student_subjects_studentId_subjectId_academicYearId_key" ON "student_subjects"("studentId", "subjectId", "academicYearId");
ALTER TABLE "student_subjects" ADD CONSTRAINT "student_subjects_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "student_subjects" ADD CONSTRAINT "student_subjects_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "student_subjects" ADD CONSTRAINT "student_subjects_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "attendance_sessions" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "classId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "subjectId" TEXT,
    "period" INTEGER,
    "markedBy" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "attendance_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "attendance_sessions_branchId_date_classId_sectionId_subjectId_period_key" ON "attendance_sessions"("branchId", "date", "classId", "sectionId", "subjectId", "period");
CREATE INDEX "attendance_sessions_branchId_date_idx" ON "attendance_sessions"("branchId", "date");
CREATE INDEX "attendance_sessions_classId_sectionId_date_idx" ON "attendance_sessions"("classId", "sectionId", "date");
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON UPDATE CASCADE;
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON UPDATE CASCADE;
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON UPDATE CASCADE;
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON UPDATE CASCADE;

CREATE TABLE "attendance_records" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "reason" TEXT,
    "leaveId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "attendance_records_sessionId_studentId_key" ON "attendance_records"("sessionId", "studentId");
CREATE INDEX "attendance_records_studentId_createdAt_idx" ON "attendance_records"("studentId", "createdAt");
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "attendance_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "attendance_amendments" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "beforeStatus" "AttendanceStatus" NOT NULL,
    "afterStatus" "AttendanceStatus" NOT NULL,
    "changedBy" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "attendance_amendments_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "attendance_amendments" ADD CONSTRAINT "attendance_amendments_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "attendance_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "staff_attendances" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "remarks" TEXT,
    "markedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "staff_attendances_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "staff_attendances_staffId_date_key" ON "staff_attendances"("staffId", "date");
CREATE INDEX "staff_attendances_branchId_date_idx" ON "staff_attendances"("branchId", "date");
ALTER TABLE "staff_attendances" ADD CONSTRAINT "staff_attendances_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_attendances" ADD CONSTRAINT "staff_attendances_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON UPDATE CASCADE;

CREATE TABLE "attendance_monthly_summaries" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "workingDays" INTEGER NOT NULL DEFAULT 0,
    "presentDays" INTEGER NOT NULL DEFAULT 0,
    "absentDays" INTEGER NOT NULL DEFAULT 0,
    "lateDays" INTEGER NOT NULL DEFAULT 0,
    "halfDays" INTEGER NOT NULL DEFAULT 0,
    "leaveDays" INTEGER NOT NULL DEFAULT 0,
    "medicalDays" INTEGER NOT NULL DEFAULT 0,
    "excusedDays" INTEGER NOT NULL DEFAULT 0,
    "percentage" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "rebuiltAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "attendance_monthly_summaries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "attendance_monthly_summaries_studentId_year_month_key" ON "attendance_monthly_summaries"("studentId", "year", "month");
CREATE INDEX "attendance_monthly_summaries_branchId_year_month_idx" ON "attendance_monthly_summaries"("branchId", "year", "month");
ALTER TABLE "attendance_monthly_summaries" ADD CONSTRAINT "attendance_monthly_summaries_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attendance_monthly_summaries" ADD CONSTRAINT "attendance_monthly_summaries_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON UPDATE CASCADE;
ALTER TABLE "attendance_monthly_summaries" ADD CONSTRAINT "attendance_monthly_summaries_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON UPDATE CASCADE;

CREATE TABLE "student_leaves" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "leaveType" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "StudentLeaveStatus" NOT NULL DEFAULT 'PENDING',
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "student_leaves_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "student_leaves_studentId_startDate_idx" ON "student_leaves"("studentId", "startDate");
ALTER TABLE "student_leaves" ADD CONSTRAINT "student_leaves_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "fee_heads" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "type" "FeeHeadType" NOT NULL DEFAULT 'TUITION',
    "isRecurring" BOOLEAN NOT NULL DEFAULT true,
    "isRefundable" BOOLEAN NOT NULL DEFAULT false,
    "gstApplicable" BOOLEAN NOT NULL DEFAULT false,
    "gstRate" DECIMAL(5,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "fee_heads_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "fee_heads_branchId_code_key" ON "fee_heads"("branchId", "code");
CREATE INDEX "fee_heads_branchId_type_idx" ON "fee_heads"("branchId", "type");
ALTER TABLE "fee_heads" ADD CONSTRAINT "fee_heads_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON UPDATE CASCADE;

CREATE TABLE "fee_structure_lines" (
    "id" TEXT NOT NULL,
    "feeStructureId" TEXT NOT NULL,
    "feeHeadId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "frequency" "FeeFrequency" NOT NULL DEFAULT 'MONTHLY',
    "dueDay" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fee_structure_lines_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "fee_structure_lines" ADD CONSTRAINT "fee_structure_lines_feeStructureId_fkey" FOREIGN KEY ("feeStructureId") REFERENCES "fee_structures"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fee_structure_lines" ADD CONSTRAINT "fee_structure_lines_feeHeadId_fkey" FOREIGN KEY ("feeHeadId") REFERENCES "fee_heads"("id") ON UPDATE CASCADE;

CREATE TABLE "fee_structure_classes" (
    "id" TEXT NOT NULL,
    "feeStructureId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fee_structure_classes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "fee_structure_classes_feeStructureId_classId_key" ON "fee_structure_classes"("feeStructureId", "classId");
ALTER TABLE "fee_structure_classes" ADD CONSTRAINT "fee_structure_classes_feeStructureId_fkey" FOREIGN KEY ("feeStructureId") REFERENCES "fee_structures"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fee_structure_classes" ADD CONSTRAINT "fee_structure_classes_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "concessions" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "feeHeadId" TEXT,
    "category" "ConcessionCategory" NOT NULL DEFAULT 'OTHER',
    "type" "ConcessionType" NOT NULL DEFAULT 'FLAT',
    "value" DECIMAL(12,2) NOT NULL,
    "reason" TEXT,
    "status" "ConcessionStatus" NOT NULL DEFAULT 'PENDING',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "concessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "concessions_studentId_academicYearId_idx" ON "concessions"("studentId", "academicYearId");
ALTER TABLE "concessions" ADD CONSTRAINT "concessions_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "concessions" ADD CONSTRAINT "concessions_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON UPDATE CASCADE;
ALTER TABLE "concessions" ADD CONSTRAINT "concessions_feeHeadId_fkey" FOREIGN KEY ("feeHeadId") REFERENCES "fee_heads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "fee_ledger" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "type" "FeeLedgerType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "feeHeadId" TEXT,
    "invoiceId" TEXT,
    "paymentId" TEXT,
    "description" TEXT,
    "reference" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fee_ledger_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "fee_ledger_studentId_academicYearId_idx" ON "fee_ledger"("studentId", "academicYearId");
CREATE INDEX "fee_ledger_branchId_createdAt_idx" ON "fee_ledger"("branchId", "createdAt");
CREATE INDEX "fee_ledger_invoiceId_idx" ON "fee_ledger"("invoiceId");
CREATE INDEX "fee_ledger_paymentId_idx" ON "fee_ledger"("paymentId");
ALTER TABLE "fee_ledger" ADD CONSTRAINT "fee_ledger_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fee_ledger" ADD CONSTRAINT "fee_ledger_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON UPDATE CASCADE;
ALTER TABLE "fee_ledger" ADD CONSTRAINT "fee_ledger_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON UPDATE CASCADE;
ALTER TABLE "fee_ledger" ADD CONSTRAINT "fee_ledger_feeHeadId_fkey" FOREIGN KEY ("feeHeadId") REFERENCES "fee_heads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "payment_allocations" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "allocatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_allocations_paymentId_invoiceId_key" ON "payment_allocations"("paymentId", "invoiceId");
CREATE INDEX "payment_allocations_invoiceId_idx" ON "payment_allocations"("invoiceId");
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- FK to the invoices table is added after the fee_invoices → invoices rename
-- (section 3), because this table is created before the rename runs.

CREATE TABLE "assessment_types" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "weightage" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "assessment_types_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "assessment_types_branchId_code_key" ON "assessment_types"("branchId", "code");
ALTER TABLE "assessment_types" ADD CONSTRAINT "assessment_types_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON UPDATE CASCADE;

CREATE TABLE "grading_schemes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "grading_schemes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "grading_schemes_branchId_academicYearId_idx" ON "grading_schemes"("branchId", "academicYearId");
ALTER TABLE "grading_schemes" ADD CONSTRAINT "grading_schemes_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON UPDATE CASCADE;
ALTER TABLE "grading_schemes" ADD CONSTRAINT "grading_schemes_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON UPDATE CASCADE;

CREATE TABLE "grade_bands" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "minPercent" DECIMAL(5,2) NOT NULL,
    "maxPercent" DECIMAL(5,2) NOT NULL,
    "points" DECIMAL(4,2),
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "grade_bands_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "grade_bands_schemeId_grade_key" ON "grade_bands"("schemeId", "grade");
ALTER TABLE "grade_bands" ADD CONSTRAINT "grade_bands_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "grading_schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "co_scholastic_areas" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "co_scholastic_areas_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "co_scholastic_areas_branchId_code_key" ON "co_scholastic_areas"("branchId", "code");
ALTER TABLE "co_scholastic_areas" ADD CONSTRAINT "co_scholastic_areas_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON UPDATE CASCADE;

CREATE TABLE "student_co_scholastics" (
    "id" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "remarks" TEXT,
    "enteredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "student_co_scholastics_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "student_co_scholastics_areaId_studentId_academicYearId_key" ON "student_co_scholastics"("areaId", "studentId", "academicYearId");
ALTER TABLE "student_co_scholastics" ADD CONSTRAINT "student_co_scholastics_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "co_scholastic_areas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "student_co_scholastics" ADD CONSTRAINT "student_co_scholastics_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "student_co_scholastics" ADD CONSTRAINT "student_co_scholastics_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON UPDATE CASCADE;

CREATE TABLE "report_card_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "board" TEXT NOT NULL DEFAULT 'CBSE',
    "branchId" TEXT NOT NULL,
    "classId" TEXT,
    "academicYearId" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "report_card_templates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "report_card_templates_branchId_academicYearId_idx" ON "report_card_templates"("branchId", "academicYearId");
ALTER TABLE "report_card_templates" ADD CONSTRAINT "report_card_templates_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON UPDATE CASCADE;
ALTER TABLE "report_card_templates" ADD CONSTRAINT "report_card_templates_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON UPDATE CASCADE;

CREATE TABLE "mark_entry_audits" (
    "id" TEXT NOT NULL,
    "examResultId" TEXT NOT NULL,
    "beforeMarks" DECIMAL(5,2),
    "afterMarks" DECIMAL(5,2),
    "changedBy" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mark_entry_audits_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "mark_entry_audits" ADD CONSTRAINT "mark_entry_audits_examResultId_fkey" FOREIGN KEY ("examResultId") REFERENCES "exam_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "timetable_substitutions" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "originalStaffId" TEXT NOT NULL,
    "substituteStaffId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "reason" TEXT,
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "timetable_substitutions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "timetable_substitutions_slotId_date_idx" ON "timetable_substitutions"("slotId", "date");
ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "timetable_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_originalStaffId_fkey" FOREIGN KEY ("originalStaffId") REFERENCES "staff"("id") ON UPDATE CASCADE;
ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_substituteStaffId_fkey" FOREIGN KEY ("substituteStaffId") REFERENCES "staff"("id") ON UPDATE CASCADE;

CREATE TABLE "sequences" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "format" TEXT,
    "currentValue" INTEGER NOT NULL DEFAULT 0,
    "padding" INTEGER NOT NULL DEFAULT 5,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sequences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sequences_branchId_code_key" ON "sequences"("branchId", "code");
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "branchId" TEXT,
    "actorId" TEXT,
    "actorRole" TEXT,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "audit_logs_entity_entityId_idx" ON "audit_logs"("entity", "entityId");
CREATE INDEX "audit_logs_branchId_createdAt_idx" ON "audit_logs"("branchId", "createdAt");
CREATE INDEX "audit_logs_actorId_idx" ON "audit_logs"("actorId");
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "studentId" TEXT,
    "staffId" TEXT,
    "type" "DocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "checksum" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "virusScanStatus" "VirusScanStatus" NOT NULL DEFAULT 'PENDING',
    "retentionUntil" TIMESTAMP(3),
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "uploadedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "documents_studentId_idx" ON "documents"("studentId");
CREATE INDEX "documents_staffId_idx" ON "documents"("staffId");
ALTER TABLE "documents" ADD CONSTRAINT "documents_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "documents" ADD CONSTRAINT "documents_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "document_access_logs" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "accessedBy" TEXT NOT NULL,
    "purpose" TEXT,
    "accessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "document_access_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "document_access_logs_documentId_idx" ON "document_access_logs"("documentId");
ALTER TABLE "document_access_logs" ADD CONSTRAINT "document_access_logs_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "settings" (
    "id" TEXT NOT NULL,
    "branchId" TEXT,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "dataType" TEXT NOT NULL DEFAULT 'string',
    "description" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "settings_branchId_key_key" ON "settings"("branchId", "key");
ALTER TABLE "settings" ADD CONSTRAINT "settings_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "notification_logs" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "template" TEXT,
    "recipientType" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "recipient" TEXT,
    "subject" TEXT,
    "body" TEXT,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT,
    "providerMessageId" TEXT,
    "cost" DECIMAL(10,4),
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notification_logs_branchId_createdAt_idx" ON "notification_logs"("branchId", "createdAt");
CREATE INDEX "notification_logs_status_idx" ON "notification_logs"("status");
CREATE INDEX "notification_logs_recipientType_recipientId_idx" ON "notification_logs"("recipientType", "recipientId");
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON UPDATE CASCADE;

-- ── 3. Additive columns on existing tables ──

ALTER TABLE "students" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "students" ADD COLUMN "deletedBy" TEXT;

ALTER TABLE "classes" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "classes" ADD COLUMN "deletedBy" TEXT;

ALTER TABLE "sections" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "sections" ADD COLUMN "deletedBy" TEXT;

ALTER TABLE "subjects" ADD COLUMN "groupId" TEXT;
ALTER TABLE "subjects" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "subjects" ADD COLUMN "deletedBy" TEXT;
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "subject_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "subjects_groupId_idx" ON "subjects"("groupId");

ALTER TABLE "timetable_slots" ADD COLUMN "staffId" TEXT;
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "guardians" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "guardians" ADD COLUMN "deletedBy" TEXT;

ALTER TABLE "staff" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "staff" ADD COLUMN "deletedBy" TEXT;

-- fee_heads and concessions already carry deletedAt/deletedBy from their
-- CREATE TABLE statements above.

ALTER TABLE "books" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "books" ADD COLUMN "deletedBy" TEXT;

ALTER TABLE "vehicles" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "vehicles" ADD COLUMN "deletedBy" TEXT;

-- fee_structures: drop the unnormalised columns; add year + category.
ALTER TABLE "fee_structures" ADD COLUMN "academicYearId" TEXT;
ALTER TABLE "fee_structures" ADD COLUMN "studentCategory" TEXT;
ALTER TABLE "fee_structures" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "fee_structures" ADD COLUMN "deletedBy" TEXT;

-- fee_invoices → invoices (model rename, BUILD_PLAN 2.5.5)
ALTER TABLE "fee_invoices" RENAME TO "invoices";
ALTER TABLE "invoices" ADD COLUMN "branchId" TEXT;
ALTER TABLE "invoices" ADD COLUMN "academicYearId" TEXT;
ALTER TABLE "invoices" ADD COLUMN "periodStart" TIMESTAMP(3);
ALTER TABLE "invoices" ADD COLUMN "periodEnd" TIMESTAMP(3);
ALTER TABLE "invoices" ADD COLUMN "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "invoices" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "invoices" ADD COLUMN "deletedBy" TEXT;
ALTER TABLE "invoices" ADD COLUMN "status_new" "InvoiceStatus";
UPDATE "invoices" SET "status_new" =
    (CASE "status"
        WHEN 'PENDING' THEN 'ISSUED'
        WHEN 'PARTIAL' THEN 'PARTIALLY_PAID'
        WHEN 'OVERDUE' THEN 'OVERDUE'
        WHEN 'WAIVED' THEN 'WAIVED'
        ELSE 'ISSUED'
    END)::"InvoiceStatus";
ALTER TABLE "invoices" ALTER COLUMN "status_new" SET NOT NULL;
ALTER TABLE "invoices" DROP COLUMN "status";
ALTER TABLE "invoices" RENAME COLUMN "status_new" TO "status";

-- fee_items → invoice_lines
ALTER TABLE "fee_items" RENAME CONSTRAINT "fee_items_invoiceId_fkey" TO "invoice_lines_invoiceId_fkey";
ALTER TABLE "fee_items" RENAME TO "invoice_lines";
ALTER TABLE "invoice_lines" ADD COLUMN "feeHeadId" TEXT;
ALTER TABLE "invoice_lines" ADD COLUMN "description" TEXT;
ALTER TABLE "invoice_lines" ADD COLUMN "concessionId" TEXT;
ALTER TABLE "invoice_lines" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "invoice_lines_invoiceId_idx" ON "invoice_lines"("invoiceId");

-- payments: state machine + gateway fields
ALTER TABLE "payments" ADD COLUMN "studentId" TEXT;
ALTER TABLE "payments" ADD COLUMN "branchId" TEXT;
ALTER TABLE "payments" ADD COLUMN "academicYearId" TEXT;
ALTER TABLE "payments" ADD COLUMN "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATED';
ALTER TABLE "payments" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "payments" ADD COLUMN "gatewayOrderId" TEXT;
ALTER TABLE "payments" ADD COLUMN "gatewayProvider" TEXT;
ALTER TABLE "payments" ADD COLUMN "rawWebhook" JSONB;
ALTER TABLE "payments" ADD COLUMN "allocationMode" "PaymentAllocationMode" NOT NULL DEFAULT 'OLDEST_DUES_FIRST';
ALTER TABLE "payments" RENAME COLUMN "transactionId" TO "gatewayPaymentId";
ALTER TABLE "payments" ALTER COLUMN "invoiceId" DROP NOT NULL;
ALTER TABLE "payments" ALTER COLUMN "method" TYPE "PaymentMethod" USING "method"::"PaymentMethod";
-- The baseline payments table had no timestamps; the Phase-2 model has them.
ALTER TABLE "payments" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "payments" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE UNIQUE INDEX "payments_idempotencyKey_key" ON "payments"("idempotencyKey");
CREATE INDEX "payments_studentId_idx" ON "payments"("studentId");
CREATE INDEX "payments_branchId_status_idx" ON "payments"("branchId", "status");

-- examinations: publication workflow + assessment type
ALTER TABLE "examinations" ADD COLUMN "assessmentTypeId" TEXT;
ALTER TABLE "examinations" ADD COLUMN "status" "ExamStatus" NOT NULL DEFAULT 'ENTRY';
ALTER TABLE "examinations" ADD COLUMN "publishedAt" TIMESTAMP(3);
ALTER TABLE "examinations" ADD COLUMN "publishedBy" TEXT;
ALTER TABLE "examinations" ADD CONSTRAINT "examinations_assessmentTypeId_fkey" FOREIGN KEY ("assessmentTypeId") REFERENCES "assessment_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- exam_results: 2.6.4
ALTER TABLE "exam_results" ADD COLUMN "moderatedMarks" DECIMAL(5,2);
ALTER TABLE "exam_results" ADD COLUMN "isAbsent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "exam_results" ADD COLUMN "isExempt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "exam_results" ADD COLUMN "attemptNo" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "exam_results" ADD COLUMN "enteredBy" TEXT;
ALTER TABLE "exam_results" ADD COLUMN "verifiedBy" TEXT;

-- ── 4. Backfill ──

-- 4.1 One current year per branch (deterministic for the backfills below).
CREATE TEMP TABLE cur_year AS
SELECT DISTINCT ON ("branchId") "branchId", id, "startDate"
FROM "academic_years"
WHERE "isCurrent" = true
ORDER BY "branchId", "startDate" DESC;

-- 4.2 Standard fee heads per branch (2.5.1). Deterministic ids → idempotent.
INSERT INTO "fee_heads" ("id", "code", "name", "branchId", "type", "isRecurring", "isRefundable", "gstApplicable", "createdAt", "updatedAt")
SELECT 'fh_' || b.id || '_TUITION',   'TUITION',   'Tuition Fee',       b.id, 'TUITION'::"FeeHeadType",   true,  false, false, now(), now() FROM "branches" b
UNION ALL
SELECT 'fh_' || b.id || '_TRANSPORT', 'TRANSPORT', 'Transport Fee',     b.id, 'TRANSPORT'::"FeeHeadType", true,  false, false, now(), now() FROM "branches" b
UNION ALL
SELECT 'fh_' || b.id || '_ADMISSION', 'ADMISSION', 'Admission Fee',     b.id, 'ADMISSION'::"FeeHeadType", false, false, false, now(), now() FROM "branches" b
UNION ALL
SELECT 'fh_' || b.id || '_EXAM',      'EXAM',      'Examination Fee',   b.id, 'EXAM'::"FeeHeadType",      false, false, false, now(), now() FROM "branches" b
UNION ALL
SELECT 'fh_' || b.id || '_LAB',       'LAB',       'Laboratory Fee',    b.id, 'LAB'::"FeeHeadType",       false, false, false, now(), now() FROM "branches" b
UNION ALL
SELECT 'fh_' || b.id || '_ANNUAL',    'ANNUAL',    'Annual Fee',        b.id, 'ANNUAL'::"FeeHeadType",    false, false, false, now(), now() FROM "branches" b
UNION ALL
SELECT 'fh_' || b.id || '_DEVELOPMENT','DEVELOPMENT','Development Fee', b.id, 'DEVELOPMENT'::"FeeHeadType", false, false, false, now(), now() FROM "branches" b
UNION ALL
SELECT 'fh_' || b.id || '_LATE_FEE',  'LATE_FEE',  'Late Fee',          b.id, 'LATE_FEE'::"FeeHeadType",  false, false, false, now(), now() FROM "branches" b
UNION ALL
SELECT 'fh_' || b.id || '_MISC',      'MISC',      'Miscellaneous',     b.id, 'MISCELLANEOUS'::"FeeHeadType", false, false, false, now(), now() FROM "branches" b;

-- 4.3 fee_structures: point at the current year, then carry amount/frequency/
--     dueDay into one line each (2.5.2). The old classIds[] become rows.
UPDATE "fee_structures" fs
SET "academicYearId" = cy.id
FROM cur_year cy
WHERE cy."branchId" = fs."branchId";

INSERT INTO "fee_structure_lines" ("id", "feeStructureId", "feeHeadId", "amount", "frequency", "dueDay", "createdAt")
SELECT 'fsl_' || fs.id,
       fs.id,
       CASE
           WHEN fs.name ILIKE '%tuition%'   THEN 'fh_' || fs."branchId" || '_TUITION'
           WHEN fs.name ILIKE '%transport%' THEN 'fh_' || fs."branchId" || '_TRANSPORT'
           WHEN fs.name ILIKE '%admission%' THEN 'fh_' || fs."branchId" || '_ADMISSION'
           WHEN fs.name ILIKE '%exam%'      THEN 'fh_' || fs."branchId" || '_EXAM'
           WHEN fs.name ILIKE '%lab%'       THEN 'fh_' || fs."branchId" || '_LAB'
           WHEN fs.name ILIKE '%development%' THEN 'fh_' || fs."branchId" || '_DEVELOPMENT'
           WHEN fs.name ILIKE '%annual%'    THEN 'fh_' || fs."branchId" || '_ANNUAL'
           ELSE 'fh_' || fs."branchId" || '_MISC'
       END,
       fs.amount,
       fs.frequency::"FeeFrequency",
       fs."dueDay",
       now()
FROM "fee_structures" fs
WHERE fs."academicYearId" IS NOT NULL;

INSERT INTO "fee_structure_classes" ("id", "feeStructureId", "classId", "createdAt")
SELECT 'fsc_' || fs.id || '_' || c, fs.id, c, now()
FROM "fee_structures" fs, unnest(fs."classIds") AS c;

-- 4.4 invoices: home the branch/year, discount default, status already cast.
UPDATE "invoices" i
SET "branchId" = s."branchId",
    "academicYearId" = COALESCE(cy.id, (SELECT id FROM "academic_years" ay WHERE ay."branchId" = s."branchId" ORDER BY ay."startDate" DESC LIMIT 1))
FROM "students" s
LEFT JOIN cur_year cy ON cy."branchId" = s."branchId"
WHERE i."studentId" = s.id;

ALTER TABLE "invoices" ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "invoices" ALTER COLUMN "academicYearId" SET NOT NULL;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON UPDATE CASCADE;

-- payment_allocations.invoiceId → invoices (created earlier, FK deferred here).
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4.5 invoice_lines: map each legacy fee_item to the fee head its structure
--     resolved to (same CASE as 4.3).
UPDATE "invoice_lines" il
SET "feeHeadId" = CASE
        WHEN fs.name ILIKE '%tuition%'   THEN 'fh_' || fs."branchId" || '_TUITION'
        WHEN fs.name ILIKE '%transport%' THEN 'fh_' || fs."branchId" || '_TRANSPORT'
        WHEN fs.name ILIKE '%admission%' THEN 'fh_' || fs."branchId" || '_ADMISSION'
        WHEN fs.name ILIKE '%exam%'      THEN 'fh_' || fs."branchId" || '_EXAM'
        WHEN fs.name ILIKE '%lab%'       THEN 'fh_' || fs."branchId" || '_LAB'
        WHEN fs.name ILIKE '%development%' THEN 'fh_' || fs."branchId" || '_DEVELOPMENT'
        WHEN fs.name ILIKE '%annual%'    THEN 'fh_' || fs."branchId" || '_ANNUAL'
        ELSE 'fh_' || fs."branchId" || '_MISC'
    END,
    "description" = fs.name
FROM "fee_structures" fs
WHERE il."feeStructureId" = fs.id;

ALTER TABLE "invoice_lines" ALTER COLUMN "feeHeadId" SET NOT NULL;
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_feeHeadId_fkey" FOREIGN KEY ("feeHeadId") REFERENCES "fee_heads"("id") ON UPDATE CASCADE;
ALTER TABLE "invoice_lines" DROP COLUMN "feeStructureId";
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_concessionId_fkey" FOREIGN KEY ("concessionId") REFERENCES "concessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4.6 payments: home branch/year/student, mark existing rows SUCCESS,
--     record the deterministic allocation, then post the ledger.
UPDATE "payments" p
SET "studentId" = i."studentId",
    "branchId"  = i."branchId",
    "academicYearId" = i."academicYearId",
    "status"    = 'SUCCESS'
FROM "invoices" i
WHERE p."invoiceId" = i.id;

ALTER TABLE "payments" ALTER COLUMN "studentId" SET NOT NULL;
ALTER TABLE "payments" ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "payments" ALTER COLUMN "academicYearId" SET NOT NULL;
ALTER TABLE "payments" ADD CONSTRAINT "payments_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON UPDATE CASCADE;

INSERT INTO "payment_allocations" ("id", "paymentId", "invoiceId", "amount", "allocatedAt")
SELECT 'pa_' || p.id, p.id, p."invoiceId", p.amount, p."paidAt"
FROM "payments" p
WHERE p."invoiceId" IS NOT NULL;

-- Ledger: one DEMAND per invoice line (net of discount) and one PAYMENT per
-- payment. Balance is derived; never a column (2.5.4).
INSERT INTO "fee_ledger" ("id", "studentId", "branchId", "academicYearId", "type", "amount", "feeHeadId", "invoiceId", "description", "reference", "createdAt")
SELECT 'lgd_' || il.id, i."studentId", i."branchId", i."academicYearId", 'DEMAND', il.amount - il.discount, il."feeHeadId", il."invoiceId", il.description, i."invoiceNo", now()
FROM "invoice_lines" il
JOIN "invoices" i ON i.id = il."invoiceId";

INSERT INTO "fee_ledger" ("id", "studentId", "branchId", "academicYearId", "type", "amount", "paymentId", "description", "reference", "createdAt")
SELECT 'lgp_' || p.id, p."studentId", p."branchId", p."academicYearId", 'PAYMENT', -p.amount, p.id, 'Payment via ' || p.method, p."receiptNo", p."paidAt"
FROM "payments" p;

-- 4.7 Enrollments: every student gets one row in the current (or latest)
--     academic year, from their live class/section/rollNo (2.2.1).
INSERT INTO "student_enrollments" ("id", "studentId", "academicYearId", "branchId", "classId", "sectionId", "rollNo", "status", "fromDate", "createdBy", "createdAt", "updatedAt")
SELECT 'se_' || s.id,
       s.id,
       COALESCE(cy.id, (SELECT id FROM "academic_years" ay WHERE ay."branchId" = s."branchId" ORDER BY ay."startDate" DESC LIMIT 1)),
       s."branchId",
       s."classId",
       s."sectionId",
       s."rollNo",
       'ENROLLED',
       COALESCE(cy."startDate", s."admissionDate"),
       'migration',
       now(),
       now()
FROM "students" s
LEFT JOIN cur_year cy ON cy."branchId" = s."branchId";

-- 4.8 Attendance: one daily session per (branch, date, class, section), one
--     record per legacy student row, staff rows → staff_attendances. The
--     session id is deterministic so records can find their session.
INSERT INTO "attendance_sessions" ("id", "branchId", "date", "classId", "sectionId", "academicYearId", "markedBy", "createdAt", "updatedAt")
SELECT 'as_' || a."branchId" || '_' || to_char(a.date, 'YYYYMMDD') || '_' || s."classId" || '_' || s."sectionId",
       a."branchId",
       a.date,
       s."classId",
       s."sectionId",
       COALESCE(cy.id, (SELECT id FROM "academic_years" ay WHERE ay."branchId" = a."branchId" ORDER BY ay."startDate" DESC LIMIT 1)),
       min(a."markedBy"),
       now(),
       now()
FROM "attendances" a
JOIN "students" s ON s.id = a."studentId"
LEFT JOIN cur_year cy ON cy."branchId" = a."branchId"
WHERE a."studentId" IS NOT NULL
GROUP BY a."branchId", a.date, s."classId", s."sectionId", cy.id;

INSERT INTO "attendance_records" ("id", "sessionId", "studentId", "status", "reason", "createdAt", "updatedAt")
SELECT 'ar_' || a.id,
       'as_' || a."branchId" || '_' || to_char(a.date, 'YYYYMMDD') || '_' || s."classId" || '_' || s."sectionId",
       a."studentId",
       a.status,
       a.remarks,
       now(),
       now()
FROM "attendances" a
JOIN "students" s ON s.id = a."studentId"
WHERE a."studentId" IS NOT NULL;

INSERT INTO "staff_attendances" ("id", "staffId", "branchId", "date", "status", "remarks", "markedBy", "createdAt")
SELECT 'sa_' || a.id, a."staffId", a."branchId", a.date, a.status, a.remarks, a."markedBy", now()
FROM "attendances" a
WHERE a."staffId" IS NOT NULL;

-- 4.9 Existing examinations stay parent-visible: mark them PUBLISHED (2.6.5).
UPDATE "examinations" SET "status" = 'PUBLISHED', "publishedAt" = now();

-- 4.10 Default CBSE grading scheme + bands per branch (2.6.2).
INSERT INTO "grading_schemes" ("id", "name", "branchId", "academicYearId", "isDefault", "isActive", "createdAt", "updatedAt")
SELECT 'gs_' || b.id, 'CBSE', b.id, cy.id, true, true, now(), now()
FROM "branches" b
JOIN cur_year cy ON cy."branchId" = b.id;

INSERT INTO "grade_bands" ("id", "schemeId", "grade", "minPercent", "maxPercent", "points", "createdAt")
SELECT 'gb_' || gs.id || '_' || b.grade, gs.id, b.grade, b."minPercent", b."maxPercent", b.points, now()
FROM "grading_schemes" gs
CROSS JOIN (VALUES
    ('A1', 91.00, 100.00, 10.00),
    ('A2', 81.00, 90.00, 9.00),
    ('B1', 71.00, 80.00, 8.00),
    ('B2', 61.00, 70.00, 7.00),
    ('C1', 51.00, 60.00, 6.00),
    ('C2', 41.00, 50.00, 5.00),
    ('D',  33.00, 40.00, 4.00),
    ('E',  0.00,  32.00, 0.00)
) AS b(grade, "minPercent", "maxPercent", points);

-- 4.11 Sequences: one per branch for the numbers the plan names (2.3.1).
INSERT INTO "sequences" ("id", "branchId", "code", "currentValue", "padding", "updatedAt")
SELECT 'seq_' || b.id || '_ADMISSION', b.id, 'ADMISSION', (SELECT count(*)::int FROM "students" s WHERE s."branchId" = b.id), 5, now() FROM "branches" b
UNION ALL
SELECT 'seq_' || b.id || '_RECEIPT',   b.id, 'RECEIPT',   (SELECT count(*)::int FROM "payments" p WHERE p."branchId" = b.id), 5, now() FROM "branches" b
UNION ALL
SELECT 'seq_' || b.id || '_INVOICE',   b.id, 'INVOICE',   (SELECT count(*)::int FROM "invoices" i WHERE i."branchId" = b.id), 5, now() FROM "branches" b
UNION ALL
SELECT 'seq_' || b.id || '_TC',        b.id, 'TC',        0, 5, now() FROM "branches" b
UNION ALL
SELECT 'seq_' || b.id || '_EMPLOYEE',  b.id, 'EMPLOYEE',  (SELECT count(*)::int FROM "staff" st WHERE st."branchId" = b.id), 5, now() FROM "branches" b;

-- ── 5. Remove legacy columns / tables / enums ──

-- Students: enrollment history supersedes the live pointers (2.2.1).
ALTER TABLE "students" DROP COLUMN "classId";
ALTER TABLE "students" DROP COLUMN "sectionId";
ALTER TABLE "students" DROP COLUMN "rollNo";

-- The daily-attendance table is fully re-homed above.
DROP TABLE "attendances";

-- fee_structures old shape (amount/frequency/dueDay/classIds) is gone.
ALTER TABLE "fee_structures" ALTER COLUMN "academicYearId" SET NOT NULL;
ALTER TABLE "fee_structures" DROP COLUMN "classIds";
ALTER TABLE "fee_structures" DROP COLUMN "amount";
ALTER TABLE "fee_structures" DROP COLUMN "frequency";
ALTER TABLE "fee_structures" DROP COLUMN "dueDay";
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON UPDATE CASCADE;

-- Scoped uniqueness (2.3.3): the old global uniques are replaced.
DROP INDEX "students_admissionNo_key";
DROP INDEX "students_admissionNo_idx";
-- students_classId_sectionId_idx was dropped implicitly with the columns above.
CREATE UNIQUE INDEX "students_branchId_admissionNo_key" ON "students"("branchId", "admissionNo");

DROP INDEX "books_isbn_key";
CREATE UNIQUE INDEX "books_branchId_isbn_key" ON "books"("branchId", "isbn");

DROP INDEX "vehicles_vehicleNo_key";
CREATE UNIQUE INDEX "vehicles_branchId_vehicleNo_key" ON "vehicles"("branchId", "vehicleNo");

-- Staff employeeId was globally unique in the baseline; now scoped per branch.
DROP INDEX "staff_employeeId_key";
DROP INDEX "staff_employeeId_idx";

DROP INDEX "fee_invoices_invoiceNo_key";
CREATE UNIQUE INDEX "invoices_branchId_invoiceNo_key" ON "invoices"("branchId", "invoiceNo");

DROP INDEX "payments_receiptNo_key";
CREATE UNIQUE INDEX "payments_branchId_receiptNo_key" ON "payments"("branchId", "receiptNo");

-- The old invoice status enum is superseded by "InvoiceStatus".
DROP TYPE "FeeStatus";

-- ── 6. New indexes ──

-- One current year per branch (2.2.3): a partial unique index.
CREATE UNIQUE INDEX "academic_years_one_current_per_branch" ON "academic_years"("branchId") WHERE "isCurrent" = true;
CREATE UNIQUE INDEX "academic_years_branchId_name_key" ON "academic_years"("branchId", "name");

COMMIT;