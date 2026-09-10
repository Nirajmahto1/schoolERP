// ──────────────────────────────────────────────
// Permission resolution (BUILD_PLAN 3.1)
//
// An access token carries role codes; what routes actually gate on are
// `module.action` permission strings. This resolves the effective permission
// set from a user's ACTIVE role assignments through role_permissions — the
// single source the gateway assertion and requirePermission() both consume.
// ──────────────────────────────────────────────

import type { PrismaClient } from '@school-erp/database';

export interface ResolvedIdentity {
  userId: string;
  email: string;
  isActive: boolean;
  branchId: string | null;
  roles: string[];
  /** Sorted, deduplicated `module.action` strings across all active roles. */
  permissions: string[];
}

export async function resolveIdentity(
  prisma: PrismaClient,
  userId: string,
): Promise<ResolvedIdentity | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      isActive: true,
      defaultBranchId: true,
      roleAssignments: {
        where: { isActive: true },
        select: {
          branchId: true,
          role: {
            select: {
              code: true,
              permissions: { select: { permission: { select: { module: true, action: true } } } },
            },
          },
        },
      },
    },
  });
  if (!user) return null;

  const roles: string[] = [];
  const permissionSet = new Set<string>();
  for (const assignment of user.roleAssignments) {
    roles.push(assignment.role.code);
    for (const rp of assignment.role.permissions) {
      permissionSet.add(`${rp.permission.module}.${rp.permission.action}`);
    }
  }

  const branchId =
    user.roleAssignments.find((a) => a.branchId)?.branchId ?? user.defaultBranchId;

  return {
    userId: user.id,
    email: user.email,
    isActive: user.isActive,
    branchId: branchId ?? null,
    roles,
    permissions: [...permissionSet].sort(),
  };
}

export function permissionsFor(identity: ResolvedIdentity): string[] {
  return identity.permissions;
}
