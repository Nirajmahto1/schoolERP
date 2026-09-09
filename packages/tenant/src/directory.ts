// ──────────────────────────────────────────────
// Login routing index (BUILD_PLAN 1.1 `user_directory`)
//
// With one database per school there is no single `users` table to query at
// login time. The directory maps email_hash → (tenant_id, user_id) so the
// gateway can route a login to the right tenant database. It stores a HASH of
// the email, never the address: it is a cross-tenant index and must not become
// a customer list leak.
//
// Lookups use SHA-256 of the lowercased email. Hashing (not encryption) is the
// right tool here: the index only needs equality, and a hash cannot be
// reversed into the customer list the way an encrypted column can by whoever
// holds the key.
// ──────────────────────────────────────────────

import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import type { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import type { PrismaClient } from '@school-erp/database';

/** SHA-256 of the lowercased email — the directory's only key material. */
export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

export interface DirectoryEntry {
  tenantId: string;
  userId: string;
}

/**
 * Where does this account log in? Returns null when unknown.
 *
 * `expectedUserId` defends against a stale entry pointing at the wrong user
 * row: the id is compared in constant time and a mismatch is treated as a
 * miss (and repaired by the next indexTenantUser write).
 */
export async function findUserTenant(
  controlPlane: ControlPlaneClient,
  email: string,
  expectedUserId?: string,
): Promise<DirectoryEntry | null> {
  const hash = emailHash(email);
  const row = await controlPlane.userDirectory.findUnique({
    where: { emailHash: hash },
    select: { tenantId: true, userId: true },
  });
  if (!row) return null;
  if (expectedUserId) {
    const a = Buffer.from(row.userId, 'utf8');
    const b = Buffer.from(expectedUserId, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  }
  return { tenantId: row.tenantId, userId: row.userId };
}

/**
 * Index one user account into the directory. Idempotent (upsert on the
 * email hash); call after every user create/email change in every tenant.
 */
export async function indexTenantUser(
  controlPlane: ControlPlaneClient,
  tenantId: string,
  user: { id: string; email: string },
): Promise<void> {
  if (!user.email) return;
  const hash = emailHash(user.email);
  await controlPlane.userDirectory.upsert({
    where: { emailHash: hash },
    create: { emailHash: hash, tenantId, userId: user.id },
    update: { tenantId, userId: user.id },
  });
}

/**
 * Index EVERY user of one tenant into the directory.
 *
 * Used by provisioning after seeding the first admin, by migration tooling
 * after imports, and by operators repairing a drifted index. Batched to keep
 * the control-plane connection budget sane.
 */
export async function indexTenantUsers(
  controlPlane: ControlPlaneClient,
  tenantId: string,
  tenantPrisma: PrismaClient,
  batchSize = 500,
): Promise<number> {
  let indexed = 0;
  let cursor: string | undefined = undefined;
  for (;;) {
    const users: Array<{ id: string; email: string }> = await tenantPrisma.user.findMany({
      select: { id: true, email: true },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    if (users.length === 0) break;
    cursor = users[users.length - 1].id;

    for (const u of users) {
      await indexTenantUser(controlPlane, tenantId, u);
      indexed += 1;
    }
  }
  return indexed;
}

/** Remove every directory entry for a tenant (hard-delete path, 1.5.3). */
export async function deindexTenant(
  controlPlane: ControlPlaneClient,
  tenantId: string,
): Promise<number> {
  const result = await controlPlane.userDirectory.deleteMany({ where: { tenantId } });
  return result.count;
}

/**
 * A fresh, unused login correlation id for structured logs. Kept alongside the
 * directory so the login path can log `directory-hit`/`directory-miss` without
 * exposing which emails exist.
 */
export function newLoginTraceId(): string {
  return randomUUID();
}
