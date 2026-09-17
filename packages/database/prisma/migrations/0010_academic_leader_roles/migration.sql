-- ──────────────────────────────────────────────
-- Academic leadership roles (HOD, Academic Head)
--
-- Schools need teacher-level staff who ALSO run their department's academics:
-- a Head of Department edits the timetable and manages subjects for their
-- domain; an Academic Head oversees the whole academic program. Until now the
-- only path was handing them PRINCIPAL — far too broad.
--
-- Both roles are seeded system roles (isSystem) with a focused grant set:
-- academics CRUD, exams manage + marks entry, student/staff READ (you cannot
-- build a timetable without seeing who teaches and who studies), plus
-- announcements and timetable builder access. No fees, no payroll, no HR
-- writes, no deletes of students.
-- ──────────────────────────────────────────────

INSERT INTO "roles" ("id", "code", "name", "description", "isSystem", "isActive", "createdAt", "updatedAt") VALUES
('sys_hod',           'HOD',            'Head of Department', 'Runs one department''s academics — timetable, subjects, teachers', true, true, now(), now()),
('sys_academic_head', 'ACADEMIC_HEAD',  'Academic Head',      'Oversees the academic program across departments', true, true, now(), now())
ON CONFLICT ("id") DO NOTHING;

-- Permission catalog rows already exist for every module×action (created by
-- the demo seed / provision-service catalog). Grant the academic subset to
-- both roles, idempotently — rp_<role>_<module>_<action> primary key.
INSERT INTO "role_permissions" ("id", "roleId", "permissionId")
SELECT 'rp_sys_hod_' || p."module" || '_' || p."action", 'sys_hod', p."id"
FROM "permissions" p
WHERE (p."module" = 'academics' AND p."action" IN ('create', 'read', 'update', 'delete'))
   OR (p."module" = 'exams'      AND p."action" IN ('create', 'read', 'update'))
   OR (p."module" = 'students'   AND p."action" = 'read')
   OR (p."module" = 'staff'      AND p."action" = 'read')
   OR (p."module" = 'attendance' AND p."action" IN ('read', 'update'))
   OR (p."module" = 'communication' AND p."action" IN ('read', 'create'))
   OR (p."module" = 'reports'    AND p."action" = 'read')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "role_permissions" ("id", "roleId", "permissionId")
SELECT 'rp_sys_academic_head_' || p."module" || '_' || p."action", 'sys_academic_head', p."id"
FROM "permissions" p
WHERE (p."module" = 'academics' AND p."action" IN ('create', 'read', 'update', 'delete'))
   OR (p."module" = 'exams'      AND p."action" IN ('create', 'read', 'update'))
   OR (p."module" = 'students'   AND p."action" = 'read')
   OR (p."module" = 'staff'      AND p."action" = 'read')
   OR (p."module" = 'attendance' AND p."action" IN ('read', 'update'))
   OR (p."module" = 'communication' AND p."action" IN ('read', 'create'))
   OR (p."module" = 'reports'    AND p."action" = 'read')
ON CONFLICT ("id") DO NOTHING;
