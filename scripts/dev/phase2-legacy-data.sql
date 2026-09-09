-- Legacy-shape data (baseline 0000 schema) used to prove the 2.8 migration
-- path transforms existing schools losslessly. Applied to a DB that has only
-- 0000_baseline, then 0001 + 0002 run on top.

BEGIN;

INSERT INTO "schools" ("id", "name", "code", "address", "city", "state", "pincode", "phone", "email", "createdAt", "updatedAt")
VALUES ('sch_legacy', 'Legacy Public School', 'LEGACY', '1 Test Road', 'Delhi', 'Delhi', '110001', '0110000000', 'legacy@school.test', now(), now());

INSERT INTO "branches" ("id", "schoolId", "name", "code", "address", "phone", "email", "createdAt", "updatedAt")
VALUES ('brn_legacy', 'sch_legacy', 'Main Campus', 'MAIN', '1 Test Road', '0110000000', 'main@school.test', now(), now());

INSERT INTO "users" ("id", "email", "passwordHash", "role", "isActive", "branchId", "schoolId", "createdAt", "updatedAt")
VALUES
  ('usr_admin', 'admin@legacy.test', '$2b$12$abcdefghijklmnopqrstuvwxyz', 'BRANCH_ADMIN', true, 'brn_legacy', 'sch_legacy', now(), now()),
  ('usr_stu',   'stu@legacy.test',   '$2b$12$abcdefghijklmnopqrstuvwxyz', 'STUDENT', true, 'brn_legacy', 'sch_legacy', now(), now()),
  ('usr_par',   'par@legacy.test',   '$2b$12$abcdefghijklmnopqrstuvwxyz', 'PARENT', true, 'brn_legacy', 'sch_legacy', now(), now()),
  ('usr_teach', 'teach@legacy.test', '$2b$12$abcdefghijklmnopqrstuvwxyz', 'TEACHER', true, 'brn_legacy', 'sch_legacy', now(), now());

INSERT INTO "permissions" ("id", "module", "action", "description")
VALUES ('perm_1', 'students', 'read', 'read students'),
       ('perm_2', 'fees', 'read', 'read fees');

INSERT INTO "role_permissions" ("id", "userId", "permissionId")
VALUES ('rp_1', 'usr_admin', 'perm_1'),
       ('rp_2', 'usr_admin', 'perm_2');

INSERT INTO "academic_years" ("id", "name", "startDate", "endDate", "isCurrent", "branchId", "createdAt", "updatedAt")
VALUES ('ay_2526', '2025-26', '2025-04-01', '2026-03-31', true, 'brn_legacy', now(), now()),
       ('ay_2425', '2024-25', '2024-04-01', '2025-03-31', false, 'brn_legacy', now(), now());

INSERT INTO "classes" ("id", "name", "numericOrder", "branchId", "academicYearId", "createdAt", "updatedAt")
VALUES ('cls_10', 'TEN', 10, 'brn_legacy', 'ay_2526', now(), now()),
       ('cls_9',  'NINE', 9, 'brn_legacy', 'ay_2526', now(), now());

INSERT INTO "sections" ("id", "name", "classId", "capacity", "createdAt", "updatedAt")
VALUES ('sec_10a', 'A', 'cls_10', 40, now(), now()),
       ('sec_9a',  'A', 'cls_9',  40, now(), now());

INSERT INTO "parents" ("id", "userId", "fatherName", "fatherPhone", "motherName", "address", "createdAt", "updatedAt")
VALUES ('par_legacy', 'usr_par', 'Test Father', '9000000001', 'Test Mother', '1 Test Road', now(), now());

INSERT INTO "students" ("id", "userId", "admissionNo", "rollNo", "firstName", "lastName", "dateOfBirth", "gender", "classId", "sectionId", "parentId", "address", "admissionDate", "branchId", "createdAt", "updatedAt")
VALUES ('stu_legacy', 'usr_stu', 'ADM-LEGACY-001', '7', 'Legacy', 'Student', '2012-05-10', 'MALE', 'cls_10', 'sec_10a', 'par_legacy', '1 Test Road', '2024-04-01', 'brn_legacy', now(), now());

INSERT INTO "staff" ("id", "userId", "employeeId", "firstName", "lastName", "dateOfBirth", "gender", "designation", "department", "qualification", "experience", "joinDate", "salary", "address", "phone", "branchId", "createdAt", "updatedAt")
VALUES ('stf_legacy', 'usr_teach', 'EMP-001', 'Test', 'Teacher', '1985-01-01', 'MALE', 'Teacher', 'Science', 'M.Sc', 10, '2015-04-01', 40000, '1 Test Road', '9000000002', 'brn_legacy', now(), now());

INSERT INTO "fee_structures" ("id", "name", "branchId", "classIds", "amount", "frequency", "dueDay", "createdAt", "updatedAt")
VALUES ('fs_tuition', 'Monthly Tuition Fee', 'brn_legacy', ARRAY['cls_10','cls_9'], 5000, 'MONTHLY', 10, now(), now()),
       ('fs_annual',  'Annual Development Fee', 'brn_legacy', ARRAY['cls_10'], 15000, 'YEARLY', 15, now(), now());

INSERT INTO "fee_invoices" ("id", "invoiceNo", "studentId", "totalAmount", "paidAmount", "dueDate", "status", "createdAt", "updatedAt")
VALUES ('inv_1', 'INV-1', 'stu_legacy', 20000, 12000, '2025-08-10', 'PARTIAL', now(), now()),
       ('inv_2', 'INV-2', 'stu_legacy', 5000, 5000, '2025-09-10', 'PAID', now(), now());

INSERT INTO "fee_items" ("id", "invoiceId", "feeStructureId", "amount", "discount")
VALUES ('fi_1', 'inv_1', 'fs_tuition', 5000, 0),
       ('fi_2', 'inv_1', 'fs_annual', 15000, 0),
       ('fi_3', 'inv_2', 'fs_tuition', 5000, 0);

INSERT INTO "payments" ("id", "invoiceId", "amount", "method", "transactionId", "receiptNo", "paidAt")
VALUES ('pay_1', 'inv_1', 7000, 'UPI', 'txn_1', 'REC-1', '2025-08-11'),
       ('pay_2', 'inv_1', 5000, 'CASH', 'txn_2', 'REC-2', '2025-08-15'),
       ('pay_3', 'inv_2', 5000, 'ONLINE', 'txn_3', 'REC-3', '2025-09-11');

INSERT INTO "attendances" ("id", "date", "status", "studentId", "staffId", "remarks", "markedBy", "branchId", "createdAt")
VALUES
  ('att_1', '2025-08-01', 'PRESENT', 'stu_legacy', NULL, NULL, 'usr_admin', 'brn_legacy', now()),
  ('att_2', '2025-08-02', 'ABSENT',  'stu_legacy', NULL, 'sick', 'usr_admin', 'brn_legacy', now()),
  ('att_3', '2025-08-01', 'PRESENT', NULL, 'stf_legacy', NULL, 'usr_admin', 'brn_legacy', now());

INSERT INTO "examinations" ("id", "name", "academicYearId", "branchId", "startDate", "endDate", "createdAt", "updatedAt")
VALUES ('exm_1', 'Term 1', 'ay_2526', 'brn_legacy', '2025-09-15', '2025-09-25', now(), now());

INSERT INTO "subjects" ("id", "name", "code", "classId", "type", "createdAt", "updatedAt")
VALUES ('sub_1', 'Mathematics', 'MATH', 'cls_10', 'THEORY', now(), now());

INSERT INTO "exam_subjects" ("id", "examinationId", "subjectId", "examDate", "startTime", "endTime", "maxMarks", "passingMarks", "createdAt")
VALUES ('es_1', 'exm_1', 'sub_1', '2025-09-15', '09:00', '12:00', 100, 33, now());

INSERT INTO "exam_results" ("id", "examSubjectId", "studentId", "marksObtained", "grade", "remarks", "createdAt", "updatedAt")
VALUES ('er_1', 'es_1', 'stu_legacy', 88.00, 'A2', NULL, now(), now());

INSERT INTO "timetable_slots" ("id", "sectionId", "subjectId", "day", "startTime", "endTime", "room", "createdAt", "updatedAt")
VALUES ('tt_1', 'sec_10a', 'sub_1', 'MONDAY', '09:00', '10:00', 'R-101', now(), now());

INSERT INTO "announcements" ("id", "title", "content", "type", "targetRoles", "branchId", "createdBy", "createdAt", "updatedAt")
VALUES ('ann_1', 'Welcome', 'Hello', 'GENERAL', ARRAY['PARENT','TEACHER']::"UserRole"[], 'brn_legacy', 'usr_admin', now(), now());

INSERT INTO "books" ("id", "title", "author", "isbn", "publisher", "category", "totalCopies", "availableCopies", "shelfLocation", "branchId", "createdAt", "updatedAt")
VALUES ('book_1', 'Maths X', 'R.D. Sharma', '978-9350943182', 'Dhanpat Rai', 'Textbook', 10, 8, 'S-1', 'brn_legacy', now(), now());

INSERT INTO "vehicles" ("id", "vehicleNo", "type", "capacity", "driverName", "driverPhone", "driverLicense", "branchId", "createdAt", "updatedAt")
VALUES ('veh_1', 'DL-01-AB-1234', 'Bus', 40, 'Rampal', '9000000003', 'DL-12345', 'brn_legacy', now(), now());

INSERT INTO "transport_routes" ("id", "name", "vehicleId", "branchId", "fare", "createdAt", "updatedAt")
VALUES ('rt_1', 'Route A', 'veh_1', 'brn_legacy', 2500, now(), now());

INSERT INTO "route_stops" ("id", "routeId", "name", "pickupTime", "dropTime", "order", "createdAt")
VALUES ('stop_1', 'rt_1', 'School', '07:50', '14:45', 1, now());

INSERT INTO "book_issues" ("id", "bookId", "studentId", "issueDate", "dueDate", "status", "createdAt", "updatedAt")
VALUES ('bi_1', 'book_1', 'stu_legacy', now(), now() + interval '14 days', 'ISSUED', now(), now());

COMMIT;