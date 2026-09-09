// ──────────────────────────────────────────────
// Least-privilege roles (1.2.2) + backup/restore drill (1.5.5) — REAL DATABASE
//
// These tests exercise the non-injected code path against the local Postgres
// cluster: an actual CREATE DATABASE, an actual login role, an actual pg_dump
// and pg_restore round-trip. Requires a superuser-capable DATABASE_URL (local
// dev; CI provides a postgres service container).
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { loadDotenv } from '@school-erp/config';
import { PrismaClient } from '@school-erp/database';
import {
  createDatabase,
  createTenantRole,
  dropDatabase,
  dropTenantRole,
  provisionTenant,
  backupTenant,
  rehearseRestore,
  safeRoleName,
  tenantRoleConnRef,
} from '../src/index';
import { toMaintenanceUrl } from '../src/config';
import { runTenantMigration } from '../src/migrate';

loadDotenv();

const hasRealCluster = !!process.env.DATABASE_URL;

describe('tenant roles + backup drill (real cluster)', () => {
  const adminUrl = () => toMaintenanceUrl(process.env.DATABASE_URL as string);
  const dbName = `t_roles_${Math.random().toString(36).slice(2, 8)}`;
  const slug = 'role-test-school';
  let connRef: string;
  let dumpFile: string | null = null;

  beforeAll(async () => {
    if (!hasRealCluster) return;
    connRef = await createDatabase(adminUrl(), dbName);
  });

  afterAll(async () => {
    if (!hasRealCluster) return;
    await dropTenantRole(adminUrl(), dbName, slug);
    await dropDatabase(adminUrl(), dbName);
    if (dumpFile && existsSync(dumpFile)) unlinkSync(dumpFile);
  });

  it.skipIf(!hasRealCluster)('builds a bounded role name', () => {
    expect(safeRoleName('dps-noida')).toBe('tenant_dps_noida_app');
    const long = safeRoleName('a-very-long-school-slug-with-many-words-in-it-here');
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^tenant_/);
  });

  it.skipIf(!hasRealCluster)(
    'creates a role that can write its own database but cannot create databases',
    async () => {
      const role = await createTenantRole(adminUrl(), dbName, slug);
      expect(role.roleName).toBe('tenant_role_test_school_app');

      const roleConnRef = tenantRoleConnRef(adminUrl(), dbName, role);
      const client = new PrismaClient({ datasourceUrl: roleConnRef });
      try {
        // Full rights inside its own database.
        await client.$executeRawUnsafe('CREATE TABLE role_probe (id int primary key)');
        await client.$executeRawUnsafe('INSERT INTO role_probe VALUES (1)');
        const rows = await client.$queryRawUnsafe<Array<{ id: number }>>('SELECT id FROM role_probe');
        expect(rows[0].id).toBe(1);
      } finally {
        await client.$disconnect();
      }

      // And none of the cluster: CREATEDB is not granted.
      const roleClient2 = new PrismaClient({ datasourceUrl: roleConnRef });
      try {
        await expect(
          roleClient2.$executeRawUnsafe(`CREATE DATABASE "should_fail_${dbName}"`),
        ).rejects.toThrow();
      } finally {
        await roleClient2.$disconnect();
      }
    },
  );

  it.skipIf(!hasRealCluster)('provisions with a real role when createDatabase is not injected', async () => {
    const { PrismaClient: ControlPlaneClient } = await import('@school-erp/control-plane');
    const controlDb = await (await import('@school-erp/testing')).TestDatabase.create(
      process.env.DATABASE_URL as string,
      { project: 'control-plane' as never },
    );
    const controlPlane = new ControlPlaneClient({ datasourceUrl: controlDb.url });
    try {
      const result = await provisionTenant(
        { slug: 'real-role-co', legalName: 'Real Role Co' },
        {
          controlPlane,
          adminDatabaseUrl: adminUrl(),
          // Keep this DB/roles suite hermetic — storage has its own tests.
          provisionStorage: async () => ({
            skipped: true as const,
            reason: 'test — object storage hermetic.',
          }),
        },
      );

      expect(result.roleName).toBe('tenant_real_role_co_app');
      expect(result.indexedUsers).toBeGreaterThan(0);
      // The connRef carries the ROLE's credentials, not the admin's.
      expect(result.connRef).toContain(encodeURIComponent(result.roleName as string));
      expect(result.connRef).not.toContain('postgres:postgres');

      // The directory was populated from the seeded tenant database.
      const dirRow = await controlPlane.userDirectory.findFirst();
      expect(dirRow?.tenantId).toBe(result.tenantId);

      // Cleanup via the hard-delete path (also exercises role drop).
      const { hardDeleteTenant, scheduleTenantDeletion } = await import('../src/lifecycle');
      await scheduleTenantDeletion(controlPlane, result.tenantId, 0);
      await hardDeleteTenant(controlPlane, result.tenantId, adminUrl());
      expect(await controlPlane.tenant.count({ where: { slug: 'real-role-co' } })).toBe(0);
    } finally {
      await controlDb.teardown();
      await controlPlane.$disconnect();
    }
  }, 120_000);

  it.skipIf(!hasRealCluster)('dumps a tenant and restores it into a scratch database', async () => {
    // Seed something to verify across the restore.
    const client = new PrismaClient({ datasourceUrl: connRef });
    try {
      await client.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS role_probe (id int primary key)');
    } finally {
      await client.$disconnect();
    }

    const backup = await backupTenant(connRef);
    dumpFile = backup.file;
    expect(backup.bytes).toBeGreaterThan(0);
    expect(backup.database).toBe(dbName);

    const drill = await rehearseRestore(adminUrl(), backup.file, {
      probeTable: 'role_probe',
      probeCount: 1,
    });
    expect(drill.tablesRestored).toBeGreaterThan(0);
    expect(drill.rowsVerified.rows).toBe(1);
    expect(drill.durationMs).toBeGreaterThan(0);
    // The scratch database is cleaned up.
    const admin = new PrismaClient({ datasourceUrl: adminUrl() });
    try {
      const left = await admin.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count FROM pg_database WHERE datname LIKE 'restore_drill_%'`;
      expect(Number(left[0].count)).toBe(0);
    } finally {
      await admin.$disconnect();
    }
  }, 120_000);
});

// runTenantMigration is exercised by provision above; imported to keep the
// module graph honest.
void runTenantMigration;
