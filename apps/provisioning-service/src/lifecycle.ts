// ──────────────────────────────────────────────
// Tenant lifecycle (BUILD_PLAN 1.5)
//
//   • suspend / resume           — non-payment handling, read-only, no deletion
//   • changePlan / recountSeats  — billing operations against the tenant DB
//   • scheduleDeletion → hardDelete — retention window, then irreversible drop
//   • exportTenant               — "your data is yours": full dump + audit
//
// Every transition is audited. Deletion records a certificate of deletion
// (a stable summary string) so the school and the platform share proof.
// ──────────────────────────────────────────────

import { PrismaClient as ControlPlaneClient, type TenantStatus } from '@school-erp/control-plane';
import { PrismaClient } from '@school-erp/database';
import { audit } from './audit';
import { dropDatabase } from './provision';

export async function suspendTenant(
  controlPlane: ControlPlaneClient,
  tenantId: string,
  reason: string,
  actor = 'cli',
): Promise<void> {
  await controlPlane.tenant.update({ where: { id: tenantId }, data: { status: 'SUSPENDED' } });
  await audit(controlPlane, actor, 'tenant.suspend', tenantId, { reason });
}

export async function resumeTenant(
  controlPlane: ControlPlaneClient,
  tenantId: string,
  actor = 'cli',
): Promise<void> {
  const tenant = await controlPlane.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error(`Unknown tenant ${tenantId}`);
  const status: TenantStatus =
    tenant.trialEndsAt && tenant.trialEndsAt > new Date() ? 'TRIAL' : 'ACTIVE';
  await controlPlane.tenant.update({ where: { id: tenantId }, data: { status } });
  await audit(controlPlane, actor, 'tenant.resume', tenantId, { status });
}

export async function changePlan(
  controlPlane: ControlPlaneClient,
  tenantId: string,
  planCode: string,
  actor = 'cli',
): Promise<void> {
  const plan = await controlPlane.plan.findUnique({ where: { code: planCode } });
  if (!plan) throw new Error(`Unknown plan code ${planCode}`);
  await controlPlane.tenant.update({ where: { id: tenantId }, data: { planId: plan.id } });
  await audit(controlPlane, actor, 'tenant.plan.change', tenantId, { planCode });
}

/** Count students in the tenant database and write the subscription's seat count. */
export async function recountSeats(
  controlPlane: ControlPlaneClient,
  tenantId: string,
  actor = 'cli',
): Promise<number> {
  const datastore = await controlPlane.tenantDatastore.findUnique({ where: { tenantId } });
  if (!datastore) throw new Error(`Tenant ${tenantId} has no datastore.`);
  const client = new PrismaClient({ datasourceUrl: datastore.connRef });
  try {
    // Phase 2: Student has no isActive column — an active student is one
    // without a soft-delete marker.
    const count = await client.student.count({ where: { deletedAt: null } });
    const active = await controlPlane.subscription.findFirst({
      where: { tenantId, status: { in: ['ACTIVE', 'TRIAL'] } },
      orderBy: { periodStart: 'desc' },
    });
    if (active) {
      await controlPlane.subscription.update({ where: { id: active.id }, data: { seats: count } });
    }
    await audit(controlPlane, actor, 'tenant.seats.recount', tenantId, { seats: count });
    return count;
  } finally {
    await client.$disconnect();
  }
}
export async function scheduleTenantDeletion(
  controlPlane: ControlPlaneClient,
  tenantId: string,
  retentionDays = 30,
  actor = 'cli',
): Promise<{ deleteAfter: Date }> {
  await controlPlane.tenant.update({ where: { id: tenantId }, data: { status: 'DELETING' } });
  const deleteAfter = new Date(Date.now() + retentionDays * 86_400_000);
  await audit(controlPlane, actor, 'tenant.delete.scheduled', tenantId, {
    retentionDays,
    deleteAfter: deleteAfter.toISOString(),
  });
  return { deleteAfter };
}

/**
 * Irreversible hard delete. Only call after the retention window has passed.
 * Returns a certificate of deletion (stable summary string) for the school.
 */
export async function hardDeleteTenant(
  controlPlane: ControlPlaneClient,
  tenantId: string,
  adminDatabaseUrl: string,
  actor = 'cli',
): Promise<string> {
  const tenant = await controlPlane.tenant.findUnique({
    where: { id: tenantId },
    include: { datastore: true },
  });
  if (!tenant) throw new Error(`Unknown tenant ${tenantId}`);
  if (tenant.status !== 'DELETING') {
    throw new Error(`Tenant ${tenant.slug} is not DELETING — schedule deletion first.`);
  }

  const dbName = `tenant_${tenant.slug.replace(/-/g, '_')}`;
  if (tenant.datastore) {
    await dropDatabase(adminDatabaseUrl, dbName);
    await controlPlane.tenantDatastore.delete({ where: { tenantId } });
  }
  await controlPlane.tenant.delete({ where: { id: tenantId } });

  const certificate = [
    'CERTIFICATE OF DELETION',
    `tenant_id: ${tenantId}`,
    `slug: ${tenant.slug}`,
    `database: ${dbName}`,
    `deleted_at: ${new Date().toISOString()}`,
    `actor: ${actor}`,
  ].join('\n');

  await audit(controlPlane, actor, 'tenant.delete.completed', null, {
    tenantId,
    slug: tenant.slug,
    database: dbName,
  });
  return certificate;
}

export interface TenantExport {
  tenantId: string;
  slug: string;
  exportedAt: string;
  tables: Array<{ table: string; rows: number; data: unknown[] }>;
}

/**
 * Full per-tenant data dump. Enumerates every table via information_schema and
 * dumps each to JSON — the "your data is yours" deliverable (BUILD_PLAN 1.5.4).
 * A production build adds pg_dump for byte-exact SQL; this is the portable core.
 */
export async function exportTenant(
  controlPlane: ControlPlaneClient,
  tenantId: string,
  actor = 'cli',
): Promise<TenantExport> {
  const tenant = await controlPlane.tenant.findUnique({
    where: { id: tenantId },
    include: { datastore: true },
  });
  if (!tenant) throw new Error(`Unknown tenant ${tenantId}`);
  if (!tenant.datastore) throw new Error(`Tenant ${tenantId} has no datastore.`);

  const client = new PrismaClient({ datasourceUrl: tenant.datastore.connRef });
  try {
    // current_schema() — not a hardcoded 'public' — so schema-isolated test
    // "databases" (and any non-default search_path) export the right tables.
    const tables = await client.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
      ORDER BY table_name`;
    const dump: TenantExport = {
      tenantId,
      slug: tenant.slug,
      exportedAt: new Date().toISOString(),
      tables: [],
    };
    for (const { table_name } of tables) {
      const rows = await client.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${table_name}"`);
      dump.tables.push({ table: table_name, rows: rows.length, data: rows });
    }
    await audit(controlPlane, actor, 'tenant.export', tenantId, { tables: dump.tables.length });
    return dump;
  } finally {
    await client.$disconnect();
  }
}