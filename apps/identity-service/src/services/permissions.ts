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
  /** Display name + photo for app chrome — resolved from the linked
   *  Staff/Student row (falls back to null; callers show initials/email). */
  name: string | null;
  photo: string | null;
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
      activeBranchId: true,
      staff: { select: { firstName: true, lastName: true, photo: true } },
      student: { select: { firstName: true, lastName: true, photo: true } },
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

  // Active-branch override first (POST /auth/switch-branch), then the legacy
  // order. A stale override (assignment removed since) degrades safely.
  const branchId =
    (user.activeBranchId && user.roleAssignments.some((a) => a.branchId === null || a.branchId === user.activeBranchId)
      ? user.activeBranchId
      : null) ??
    user.roleAssignments.find((a) => a.branchId)?.branchId ??
    user.defaultBranchId;

  // Chrome identity: the linked Staff or Student row wins over the email
  // local-part. Guardians keep the email fallback (no profile row of their own).
  const profile = user.staff ?? user.student ?? null;
  const name = profile ? `${profile.firstName} ${profile.lastName}`.trim() : null;

  return {
    userId: user.id,
    email: user.email,
    isActive: user.isActive,
    branchId: branchId ?? null,
    roles,
    permissions: [...permissionSet].sort(),
    name,
    photo: profile?.photo ?? null,
  };
}

export function permissionsFor(identity: ResolvedIdentity): string[] {
  return identity.permissions;
}
