-- ─────────────────────────────────────────────────────────────
-- Phase 2.1 — Identity: roles, branch-scoped permissions, guardians
--
-- Data-preserving by construction (BUILD_PLAN 2.8: additive → backfill → remove):
--   1. create new tables & enum
--   2. seed system roles
--   3. backfill legacy users → roles + role_permissions + role assignments
--   4. migrate parents → guardians (SAME ids, so student_guardians can reuse
--      the old students.parentId)
--   5. only then drop the legacy columns/table/enum

BEGIN;

-- ── 1. New enum ──
CREATE TYPE "GuardianRelation" AS ENUM ('FATHER', 'MOTHER', 'GUARDIAN', 'GRANDFATHER', 'GRANDMOTHER', 'OTHER');

-- ── 2. New tables (no foreign keys yet — they reference tables we still need) ──
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");
CREATE INDEX "roles_isActive_idx" ON "roles"("isActive");

CREATE TABLE "user_role_assignments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "branchId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_role_assignments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "user_role_assignments_roleId_idx" ON "user_role_assignments"("roleId");
CREATE INDEX "user_role_assignments_branchId_idx" ON "user_role_assignments"("branchId");
CREATE UNIQUE INDEX "user_role_assignments_userId_roleId_branchId_key" ON "user_role_assignments"("userId", "roleId", "branchId");

CREATE TABLE "guardians" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "occupation" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "address" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "guardians_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guardians_userId_key" ON "guardians"("userId");
CREATE INDEX "guardians_fullName_idx" ON "guardians"("fullName");

CREATE TABLE "student_guardians" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "guardianId" TEXT NOT NULL,
    "relation" "GuardianRelation" NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "canPickup" BOOLEAN NOT NULL DEFAULT false,
    "receivesComms" BOOLEAN NOT NULL DEFAULT true,
    "hasPortalAccess" BOOLEAN NOT NULL DEFAULT true,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "student_guardians_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "student_guardians_guardianId_idx" ON "student_guardians"("guardianId");
CREATE UNIQUE INDEX "student_guardians_studentId_guardianId_key" ON "student_guardians"("studentId", "guardianId");

CREATE TABLE "staff_branch_assignments" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "staff_branch_assignments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "staff_branch_assignments_staffId_branchId_key" ON "staff_branch_assignments"("staffId", "branchId");
-- ── 3. Seed system roles ──
INSERT INTO "roles" ("id", "code", "name", "description", "isSystem", "isActive", "createdAt", "updatedAt") VALUES
('sys_super_admin',   'SUPER_ADMIN',   'Super Admin',   'Platform operator — full access', true, true, now(), now()),
('sys_branch_admin',  'BRANCH_ADMIN',  'Branch Admin',  'Administers one branch', true, true, now(), now()),
('sys_principal',     'PRINCIPAL',     'Principal',     'Leads the school', true, true, now(), now()),
('sys_teacher',       'TEACHER',       'Teacher',       'Teaches classes and marks attendance', true, true, now(), now()),
('sys_student',       'STUDENT',       'Student',       'Accesses own record', true, true, now(), now()),
('sys_parent',        'PARENT',        'Parent/Guardian','Accesses own children', true, true, now(), now()),
('sys_accountant',    'ACCOUNTANT',    'Accountant',    'Manages fees and ledgers', true, true, now(), now()),
('sys_librarian',     'LIBRARIAN',     'Librarian',     'Manages the library', true, true, now(), now()),
('sys_transport_manager', 'TRANSPORT_MANAGER', 'Transport Manager', 'Manages vehicles and routes', true, true, now(), now()),
('sys_finance',       'FINANCE',       'Finance',       'Handles payables and receivables', true, true, now(), now());

-- ── 4. Backfill role assignments from legacy users.role ──
INSERT INTO "user_role_assignments" ("id", "userId", "roleId", "branchId", "isActive", "createdAt")
SELECT 'ura_' || u.id, u.id, r.id, u."branchId", true, now()
FROM "users" u
JOIN "roles" r ON r."code" = u."role"::text;

-- ── 5. Backfill role_permissions: legacy direct grants become grants on the
--      matching system role (lossless RBAC conversion) ──
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_userId_fkey";
DROP INDEX "role_permissions_userId_permissionId_key";
ALTER TABLE "role_permissions" ADD COLUMN "roleId" TEXT;

UPDATE "role_permissions" rp
SET "roleId" = r.id
FROM "users" u
JOIN "roles" r ON r."code" = u."role"::text
WHERE rp."userId" = u.id;

DELETE FROM "role_permissions" WHERE "roleId" IS NULL;

ALTER TABLE "role_permissions" ALTER COLUMN "roleId" SET NOT NULL;
ALTER TABLE "role_permissions" DROP COLUMN "userId";

CREATE INDEX "role_permissions_permissionId_idx" ON "role_permissions"("permissionId");
CREATE UNIQUE INDEX "role_permissions_roleId_permissionId_key" ON "role_permissions"("roleId", "permissionId");

-- ── 6. Migrate parents → guardians (same PKs) and link students ──
INSERT INTO "guardians" ("id", "userId", "fullName", "phone", "email", "occupation", "dateOfBirth", "address", "isActive", "createdAt", "updatedAt")
SELECT p.id, p."userId",
       COALESCE(NULLIF(p."fatherName", ''), NULLIF(p."motherName", ''), NULLIF(p."guardianName", ''), 'Guardian'),
       COALESCE(p."fatherPhone", p."motherPhone", p."guardianPhone"),
       COALESCE(p."fatherEmail", p."motherEmail"),
       COALESCE(p."fatherOccupation", p."motherOccupation"),
       p."dateOfBirth", p."address", true, now(), now()
FROM "parents" p;

INSERT INTO "student_guardians" ("id", "studentId", "guardianId", "relation", "isPrimary", "canPickup", "receivesComms", "hasPortalAccess", "createdAt")
SELECT 'sg_' || s.id, s.id, s."parentId", 'GUARDIAN', true, true, true, true, now()
FROM "students" s
WHERE s."parentId" IS NOT NULL;
-- ── 7. User columns introduced by the 2.1 model ──
ALTER TABLE "users" ADD COLUMN "defaultBranchId" TEXT;
ALTER TABLE "users" ADD COLUMN "mfaSecret" TEXT;
ALTER TABLE "users" ADD CONSTRAINT "users_defaultBranchId_fkey"
  FOREIGN KEY ("defaultBranchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 8. Foreign keys for the new tables (created without FKs in step 2) ──
ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "guardians" ADD CONSTRAINT "guardians_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_guardianId_fkey"
  FOREIGN KEY ("guardianId") REFERENCES "guardians"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "staff_branch_assignments" ADD CONSTRAINT "staff_branch_assignments_staffId_fkey"
  FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_branch_assignments" ADD CONSTRAINT "staff_branch_assignments_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 9. Drop the legacy identity columns/table (users.role, users.schoolId,
--      users.branchId, students.parentId, parents) ──
ALTER TABLE "users" DROP COLUMN "role";
ALTER TABLE "users" DROP COLUMN "schoolId";
ALTER TABLE "users" DROP COLUMN "branchId";

ALTER TABLE "students" DROP COLUMN "parentId";
DROP TABLE "parents";

-- ── 10. Announcements now target Role codes (text), not the UserRole enum ──
ALTER TABLE "announcements" ALTER COLUMN "targetRoles" SET DATA TYPE TEXT[] USING "targetRoles"::text[];

DROP TYPE "UserRole";

COMMIT;
