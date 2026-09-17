// ──────────────────────────────────────────────
// Permission catalog seeding (first-run parity with the demo seed)
//
// Migration 0001 creates the system ROLES but no permissions, so a
// wizard-bootstrapped tenant would leave its owner with an empty /me
// permission set and a blank UI. This mirrors the demo seed's MODULES ×
// ACTIONS catalog and the SUPER_ADMIN / BRANCH_ADMIN grants so both
// onboarding paths produce an equally usable tenant.
// ──────────────────────────────────────────────

import type { PrismaClient } from '@school-erp/database';

const MODULES = ['students', 'staff', 'academics', 'attendance', 'fees', 'communication', 'library', 'transport', 'reports', 'exams'] as const;
const ACTIONS = ['create', 'read', 'update', 'delete'] as const;

/** Every module×action permission a tenant needs, created idempotently. */
export async function ensurePermissionCatalog(prisma: PrismaClient): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const module of MODULES) {
    for (const action of ACTIONS) {
      const permission = await prisma.permission.upsert({
        where: { module_action: { module, action } },
        create: { module, action },
        update: {},
        select: { id: true },
      });
      ids.set(`${module}.${action}`, permission.id);
    }
  }
  return ids;
}

/**
 * Grant every permission to the two roles the first-run page relies on:
 * the wizard owner (SUPER_ADMIN) and any branch admins created later.
 * Mirrors the demo seed's `modulesFor` mapping for these two codes.
 */
export async function ensureAdminRolePermissions(prisma: PrismaClient, roleCodes: string[]): Promise<void> {
  const permissionIds = await ensurePermissionCatalog(prisma);
  const roles = await prisma.role.findMany({
    where: { code: { in: roleCodes } },
    select: { id: true, code: true },
  });
  for (const role of roles) {
    await prisma.rolePermission.createMany({
      data: [...permissionIds.entries()].map(([key, permissionId]) => {
        const [module, action] = key.split('.');
        return { id: `rp_${role.id}_${module}_${action}`, roleId: role.id, permissionId };
      }),
      skipDuplicates: true,
    });
  }
}

/**
 * Academic leadership grants (HOD / ACADEMIC_HEAD): a focused subset —
 * full academics CRUD, exam management + marks entry, read-only students
 * and staff (a timetable builder must see who teaches and who studies),
 * attendance update, announcements, reports. No fees, payroll or deletes.
 *
 * Migration 0010 seeds this for existing tenants; this mirrors it for fresh
 * wizard bootstraps so both paths produce working academic leaders.
 */
const ACADEMIC_LEADER_GRANTS: Array<Record<string, string[]>> = [
  { academics: ['create', 'read', 'update', 'delete'] },
  { exams: ['create', 'read', 'update'] },
  { students: ['read'] },
  { staff: ['read'] },
  { attendance: ['read', 'update'] },
  { communication: ['read', 'create'] },
  { reports: ['read'] },
];

export async function ensureAcademicLeaderPermissions(prisma: PrismaClient): Promise<void> {
  const permissionIds = await ensurePermissionCatalog(prisma);
  const roles = await prisma.role.findMany({
    where: { code: { in: ['HOD', 'ACADEMIC_HEAD'] } },
    select: { id: true, code: true },
  });
  for (const role of roles) {
    const data = [];
    for (const grant of ACADEMIC_LEADER_GRANTS) {
      const [module, actions] = Object.entries(grant)[0];
      for (const action of actions) {
        const permissionId = permissionIds.get(`${module}.${action}`);
        if (permissionId) data.push({ id: `rp_${role.id}_${module}_${action}`, roleId: role.id, permissionId });
      }
    }
    await prisma.rolePermission.createMany({ data, skipDuplicates: true });
  }
}
