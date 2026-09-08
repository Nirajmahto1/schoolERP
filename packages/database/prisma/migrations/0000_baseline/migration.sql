-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'STUDENT', 'PARENT', 'ACCOUNTANT', 'LIBRARIAN', 'TRANSPORT_MANAGER', 'FINANCE');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'HALF_DAY', 'ON_LEAVE');

-- CreateEnum
CREATE TYPE "FeeStatus" AS ENUM ('PENDING', 'PARTIAL', 'PAID', 'OVERDUE', 'WAIVED');

-- CreateTable
CREATE TABLE "schools" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "website" TEXT,
    "logo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "branchId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "lastLogin" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academic_years" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "branchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "academic_years_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "admissionNo" TEXT NOT NULL,
    "rollNo" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3) NOT NULL,
    "gender" "Gender" NOT NULL,
    "bloodGroup" TEXT,
    "classId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "phone" TEXT,
    "photo" TEXT,
    "previousSchool" TEXT,
    "admissionDate" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "branchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parents" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "fatherName" TEXT NOT NULL,
    "fatherPhone" TEXT NOT NULL,
    "fatherEmail" TEXT,
    "fatherOccupation" TEXT,
    "motherName" TEXT NOT NULL,
    "motherPhone" TEXT,
    "motherEmail" TEXT,
    "motherOccupation" TEXT,
    "guardianName" TEXT,
    "guardianPhone" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "address" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3) NOT NULL,
    "gender" "Gender" NOT NULL,
    "designation" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "qualification" TEXT NOT NULL,
    "experience" INTEGER NOT NULL DEFAULT 0,
    "joinDate" TIMESTAMP(3) NOT NULL,
    "salary" DECIMAL(12,2) NOT NULL,
    "address" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "photo" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "branchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "leaveType" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payrolls" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "basicSalary" DECIMAL(12,2) NOT NULL,
    "allowances" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deductions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netSalary" DECIMAL(12,2) NOT NULL,
    "paidOn" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payrolls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "numericOrder" INTEGER NOT NULL,
    "branchId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sections" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 40,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subjects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'THEORY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subject_teachers" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subject_teachers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendances" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "studentId" TEXT,
    "staffId" TEXT,
    "remarks" TEXT,
    "markedBy" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_structures" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "classIds" TEXT[],
    "amount" DECIMAL(12,2) NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "dueDay" INTEGER NOT NULL DEFAULT 10,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_structures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_invoices" (
    "id" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "FeeStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_items" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "feeStructureId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "fee_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" TEXT NOT NULL,
    "transactionId" TEXT,
    "receiptNo" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "examinations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "examinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_subjects" (
    "id" TEXT NOT NULL,
    "examinationId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "examDate" TIMESTAMP(3) NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "maxMarks" INTEGER NOT NULL,
    "passingMarks" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_results" (
    "id" TEXT NOT NULL,
    "examSubjectId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "marksObtained" DECIMAL(5,2) NOT NULL,
    "grade" TEXT,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exam_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_slots" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "room" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timetable_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'GENERAL',
    "targetRoles" "UserRole"[],
    "branchId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "books" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "isbn" TEXT,
    "publisher" TEXT,
    "category" TEXT NOT NULL,
    "totalCopies" INTEGER NOT NULL DEFAULT 1,
    "availableCopies" INTEGER NOT NULL DEFAULT 1,
    "shelfLocation" TEXT,
    "branchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "books_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "book_issues" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "returnDate" TIMESTAMP(3),
    "fine" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "book_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" TEXT NOT NULL,
    "vehicleNo" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "driverName" TEXT NOT NULL,
    "driverPhone" TEXT NOT NULL,
    "driverLicense" TEXT NOT NULL,
    "insuranceExpiry" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "branchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transport_routes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "fare" DECIMAL(8,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transport_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_stops" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pickupTime" TEXT NOT NULL,
    "dropTime" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "route_stops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "schools_code_key" ON "schools"("code");

-- CreateIndex
CREATE UNIQUE INDEX "schools_email_key" ON "schools"("email");

-- CreateIndex
CREATE UNIQUE INDEX "branches_schoolId_code_key" ON "branches"("schoolId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_branchId_idx" ON "users"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_module_action_key" ON "permissions"("module", "action");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_userId_permissionId_key" ON "role_permissions"("userId", "permissionId");

-- CreateIndex
CREATE UNIQUE INDEX "students_userId_key" ON "students"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "students_admissionNo_key" ON "students"("admissionNo");

-- CreateIndex
CREATE INDEX "students_branchId_idx" ON "students"("branchId");

-- CreateIndex
CREATE INDEX "students_classId_sectionId_idx" ON "students"("classId", "sectionId");

-- CreateIndex
CREATE INDEX "students_admissionNo_idx" ON "students"("admissionNo");

-- CreateIndex
CREATE UNIQUE INDEX "parents_userId_key" ON "parents"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "staff_userId_key" ON "staff"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "staff_employeeId_key" ON "staff"("employeeId");

-- CreateIndex
CREATE INDEX "staff_branchId_idx" ON "staff"("branchId");

-- CreateIndex
CREATE INDEX "staff_employeeId_idx" ON "staff"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "payrolls_staffId_month_year_key" ON "payrolls"("staffId", "month", "year");

-- CreateIndex
CREATE UNIQUE INDEX "classes_branchId_name_academicYearId_key" ON "classes"("branchId", "name", "academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "sections_classId_name_key" ON "sections"("classId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_classId_code_key" ON "subjects"("classId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "subject_teachers_subjectId_staffId_key" ON "subject_teachers"("subjectId", "staffId");

-- CreateIndex
CREATE INDEX "attendances_branchId_date_idx" ON "attendances"("branchId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "attendances_date_studentId_key" ON "attendances"("date", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "attendances_date_staffId_key" ON "attendances"("date", "staffId");

-- CreateIndex
CREATE UNIQUE INDEX "fee_invoices_invoiceNo_key" ON "fee_invoices"("invoiceNo");

-- CreateIndex
CREATE INDEX "fee_invoices_studentId_idx" ON "fee_invoices"("studentId");

-- CreateIndex
CREATE INDEX "fee_invoices_status_idx" ON "fee_invoices"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payments_receiptNo_key" ON "payments"("receiptNo");

-- CreateIndex
CREATE UNIQUE INDEX "exam_subjects_examinationId_subjectId_key" ON "exam_subjects"("examinationId", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "exam_results_examSubjectId_studentId_key" ON "exam_results"("examSubjectId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_slots_sectionId_day_startTime_key" ON "timetable_slots"("sectionId", "day", "startTime");

-- CreateIndex
CREATE INDEX "announcements_branchId_idx" ON "announcements"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "books_isbn_key" ON "books"("isbn");

-- CreateIndex
CREATE INDEX "books_isbn_idx" ON "books"("isbn");

-- CreateIndex
CREATE INDEX "books_branchId_idx" ON "books"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_vehicleNo_key" ON "vehicles"("vehicleNo");

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "parents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parents" ADD CONSTRAINT "parents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_teachers" ADD CONSTRAINT "subject_teachers_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_teachers" ADD CONSTRAINT "subject_teachers_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_invoices" ADD CONSTRAINT "fee_invoices_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_items" ADD CONSTRAINT "fee_items_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "fee_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_items" ADD CONSTRAINT "fee_items_feeStructureId_fkey" FOREIGN KEY ("feeStructureId") REFERENCES "fee_structures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "fee_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "examinations" ADD CONSTRAINT "examinations_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "examinations" ADD CONSTRAINT "examinations_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_subjects" ADD CONSTRAINT "exam_subjects_examinationId_fkey" FOREIGN KEY ("examinationId") REFERENCES "examinations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_subjects" ADD CONSTRAINT "exam_subjects_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_examSubjectId_fkey" FOREIGN KEY ("examSubjectId") REFERENCES "exam_subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "books" ADD CONSTRAINT "books_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_issues" ADD CONSTRAINT "book_issues_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "books"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_issues" ADD CONSTRAINT "book_issues_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "transport_routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

