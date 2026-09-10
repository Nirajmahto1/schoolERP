-- ──────────────────────────────────────────────
-- Phase 3: admissions pipeline + transfer certificates
--
-- Additive only: new tables, no changes to existing columns. Part of the
-- Phase 3.2 student-service buildout (BUILD_PLAN §3.2: admissions enquiry →
-- application → admission, TC generation).
-- ──────────────────────────────────────────────

-- ── Admissions pipeline ──

CREATE TABLE "admission_enquiries" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "studentName" TEXT NOT NULL,
    "classAppliedId" TEXT,
    "parentName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "source" TEXT NOT NULL DEFAULT 'WALK_IN',
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "followUpAt" TIMESTAMP(3),
    "notes" TEXT,
    "convertedApplicationId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admission_enquiries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "admission_applications" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "enquiryId" TEXT,
    "applicationNo" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3) NOT NULL,
    "gender" TEXT NOT NULL,
    "previousSchool" TEXT,
    "guardianName" TEXT NOT NULL,
    "guardianPhone" TEXT NOT NULL,
    "guardianEmail" TEXT,
    "guardianRelation" TEXT NOT NULL DEFAULT 'FATHER',
    "classAppliedId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "admittedStudentId" TEXT,
    "remarks" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admission_applications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admission_applications_branchId_applicationNo_key" ON "admission_applications"("branchId", "applicationNo");
CREATE INDEX "admission_enquiries_branchId_status_idx" ON "admission_enquiries"("branchId", "status");
CREATE INDEX "admission_enquiries_branchId_phone_idx" ON "admission_enquiries"("branchId", "phone");
CREATE INDEX "admission_applications_branchId_status_idx" ON "admission_applications"("branchId", "status");

ALTER TABLE "admission_enquiries" ADD CONSTRAINT "admission_enquiries_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admission_enquiries" ADD CONSTRAINT "admission_enquiries_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admission_enquiries" ADD CONSTRAINT "admission_enquiries_classAppliedId_fkey" FOREIGN KEY ("classAppliedId") REFERENCES "classes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "admission_applications" ADD CONSTRAINT "admission_applications_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admission_applications" ADD CONSTRAINT "admission_applications_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admission_applications" ADD CONSTRAINT "admission_applications_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "admission_enquiries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "admission_applications" ADD CONSTRAINT "admission_applications_classAppliedId_fkey" FOREIGN KEY ("classAppliedId") REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admission_applications" ADD CONSTRAINT "admission_applications_admittedStudentId_fkey" FOREIGN KEY ("admittedStudentId") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Transfer certificates (TC generation, 3.2) ──

CREATE TABLE "transfer_certificates" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "enrollmentId" TEXT,
    "tcNo" TEXT NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "remarks" TEXT,
    "lastClassId" TEXT,
    "feeDuesCleared" BOOLEAN NOT NULL DEFAULT true,
    "issuedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_certificates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "transfer_certificates_branchId_tcNo_key" ON "transfer_certificates"("branchId", "tcNo");
CREATE INDEX "transfer_certificates_branchId_idx" ON "transfer_certificates"("branchId");
CREATE INDEX "transfer_certificates_studentId_idx" ON "transfer_certificates"("studentId");

ALTER TABLE "transfer_certificates" ADD CONSTRAINT "transfer_certificates_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transfer_certificates" ADD CONSTRAINT "transfer_certificates_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
