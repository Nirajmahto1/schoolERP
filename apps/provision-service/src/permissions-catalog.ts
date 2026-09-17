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
