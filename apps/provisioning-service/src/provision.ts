// ──────────────────────────────────────────────
// Tenant provisioning pipeline (BUILD_PLAN 1.2)
//
// Idempotent and resumable:
//   • a fully-provisioned slug returns the existing tenant (no-op)
//   • a half-provisioned tenant (row but no datastore) resumes from where it
//     stopped instead of failing
//   • every step is undoable; a failure rolls back in reverse and records a
//     `tenant.provision.rollback` audit event so a half-provisioned tenant is
//     cleanable by one command (and by the pipeline itself).
// ──────────────────────────────────────────────

import { PrismaClient as ControlPlaneClient, type TenantStatus } from '@school-erp/control-plane';
import { PrismaClient } from '@school-erp/database';
import { audit } from './audit';
import { normalizeSlug, slugProblem } from './slugs';
import { seedIndiaDefaults, type SeedDefaultsResult } from './defaults';
import { runTenantMigration } from './migrate';
import { tenantConnectionRef, tenantDatabaseName } from './config';
import {
  createTenantRole,
  dropTenantRole,
  tenantRoleConnRef,
  type TenantRole,
} from './roles';
import { indexTenantUsers } from '@school-erp/tenant';
import {
  provisionTenantStorageOrDefault,
  type StorageSkipped,
  type TenantStorage,
} from './storage';

export interface CreateTenantInput {
  slug: string;
  legalName: string;
  planCode?: string;
  region?: string;
  trialDays?: number;
}

export interface ProvisionDeps {
  controlPlane: ControlPlaneClient;
  /** Maintenance URL (usually .../postgres) with CREATE/DROP DATABASE rights. */
  adminDatabaseUrl: string;
  actor?: string;
  /** Injectable so tests can create cheap schema-isolated "databases". */
  createDatabase?: (dbName: string) => Promise<string>;
  dropDatabase?: (dbName: string) => Promise<void>;
  migrate?: (connRef: string) => Promise<void>;
  seed?: (connRef: string, input: CreateTenantInput) => Promise<SeedDefaultsResult>;
  /**
   * Least-privilege role creation (1.2.2). Defaults to real CREATE ROLE SQL —
   * but is SKIPPED when `createDatabase` is injected (test/schema isolation).
   * When provided, the datastore connRef carries the role's credentials.
   */
  createRole?: (dbName: string, slug: string) => Promise<TenantRole>;
  dropRole?: (dbName: string, slug: string) => Promise<void>;
  /** Directory indexing (1.1). Defaults to indexing every seeded user. */
  indexDirectory?: (tenantId: string, connRef: string) => Promise<number>;
  /**
   * Object storage (1.2.5). Defaults to real MinIO when MINIO_* is set,
   * skipped otherwise. Best-effort: a storage failure is audited but does
   * NOT fail the tenant — object storage has no consumer until Phase 2/3.
   */
  provisionStorage?: (slug: string) => Promise<TenantStorage | StorageSkipped>;
}

export interface CreateTenantResult {
  tenantId: string;
  slug: string;
  database: string;
  connRef: string;
  schemaVersion: number;
  adminUserId: string | null;
  setupUrl: string | null;
  alreadyProvisioned: boolean;
  /** Least-privilege Postgres role owning this tenant's database (1.2.2). */
  roleName: string | null;
  /** Users indexed into the control-plane user_directory (1.1). */
  indexedUsers: number;
  /** Object storage (1.2.5): bucket + scoped credentials, or a skip note. */
  storage: TenantStorage | StorageSkipped;
}

export async function databaseExists(adminUrl: string, dbName: string): Promise<boolean> {
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    const rows = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM pg_database WHERE datname = ${dbName}`;
    return Number(rows[0]?.count ?? 0) > 0;
  } finally {
    await admin.$disconnect();
  }
}

export async function createDatabase(adminUrl: string, dbName: string): Promise<string> {
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    if (!(await databaseExists(adminUrl, dbName))) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    }
    return tenantConnectionRef(adminUrl, dbName);
  } finally {
    await admin.$disconnect();
  }
}

export async function dropDatabase(adminUrl: string, dbName: string): Promise<void> {
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    // WITH (FORCE) terminates lingering connections (Postgres 13+).
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await admin.$disconnect();
  }
}
export async function provisionTenant(
  input: CreateTenantInput,
  deps: ProvisionDeps,
): Promise<CreateTenantResult> {
  const actor = deps.actor ?? 'cli';
  const slug = normalizeSlug(input.slug);
  const problem = slugProblem(slug);
  if (problem) throw new Error(`Invalid slug: ${problem}`);

  const { controlPlane } = deps;

  const existing = await controlPlane.tenant.findUnique({
    where: { slug },
    include: { datastore: true },
  });

  // Already fully provisioned — idempotent no-op.
  if (existing?.datastore) {
    return {
      tenantId: existing.id,
      slug,
      database: tenantDatabaseName(slug),
      connRef: existing.datastore.connRef,
      schemaVersion: existing.datastore.schemaVersion,
      adminUserId: null,
      setupUrl: null,
      alreadyProvisioned: true,
      roleName: null,
      indexedUsers: 0,
      storage: { skipped: true, reason: 'already provisioned — storage unchanged.' },
    };
  }

  const undo: Array<() => Promise<void>> = [];
  let tenantId: string | null = existing?.id ?? null;

  // A row that may or may not have its datastore yet (datastore is optional in
  // this union because a freshly-created tenant row has none).
  let tenant: {
    id: string;
    slug: string;
    status: TenantStatus;
    planId: string | null;
    region: string;
    trialEndsAt: Date | null;
    datastore?: { connRef: string; schemaVersion: number } | null;
  } | null = existing;

  try {
    if (!tenant) {
      const plan = input.planCode
        ? await controlPlane.plan.findUnique({ where: { code: input.planCode } })
        : null;
      tenant = await controlPlane.tenant.create({
        data: {
          slug,
          legalName: input.legalName,
          status: 'TRIAL',
          region: input.region ?? 'ap-south-1',
          planId: plan?.id ?? null,
          trialEndsAt: input.trialDays
            ? new Date(Date.now() + input.trialDays * 86_400_000)
            : null,
        },
      });
      undo.push(async () => {
        await controlPlane.tenant.delete({ where: { id: tenant!.id } });
      });
    }
    const id = tenant!.id;
    tenantId = id;
    await audit(controlPlane, actor, 'tenant.provision.start', id, { slug, legalName: input.legalName });

    // 2. Database.
    const dbName = tenantDatabaseName(slug);
    const createDb = deps.createDatabase ?? ((n: string) => createDatabase(deps.adminDatabaseUrl, n));
    const rawConnRef = await createDb(dbName);
    undo.push(async () => {
      const dropDb = deps.dropDatabase ?? ((n: string) => dropDatabase(deps.adminDatabaseUrl, n));
      await dropDb(dbName);
    });

    // 2b. Least-privilege role (1.2.2). Real runs get a dedicated LOGIN role
    // owning only this database; the connRef then carries ITS credentials, so
    // a leaked tenant connection string is scoped to one school. Schema-
    // isolated tests skip roles entirely.
    let role: TenantRole | null = null;
    if (deps.createRole) {
      role = await deps.createRole(dbName, slug);
      undo.push(async () => {
        const dropRole = deps.dropRole ?? ((n: string, s: string) => dropTenantRole(deps.adminDatabaseUrl, n, s));
        await dropRole(dbName, slug);
      });
    } else if (!deps.createDatabase) {
      role = await createTenantRole(deps.adminDatabaseUrl, dbName, slug);
      undo.push(async () => {
        await dropTenantRole(deps.adminDatabaseUrl, dbName, slug);
      });
    }
    const connRef = role ? tenantRoleConnRef(deps.adminDatabaseUrl, dbName, role) : rawConnRef;

    // 3. Schema migration.
    const migrate = deps.migrate ?? runTenantMigration;
    await migrate(connRef);

    // 4. India defaults + first admin.
    const seed = deps.seed ?? (async (connRef2, inp) => {
      const tenantClient = new PrismaClient({ datasourceUrl: connRef2 });
      try {
        return await seedIndiaDefaults(tenantClient, {
          legalName: inp.legalName,
          slug: inp.slug,
          appBaseUrl: `https://${inp.slug}.yourapp.in`,
        });
      } finally {
        await tenantClient.$disconnect();
      }
    });
    const seeded = await seed(connRef, { ...input, slug });

    // 4b. Directory index (1.1): email_hash → tenant for login routing.
    const indexDirectory =
      deps.indexDirectory ??
      (async (tenantId2: string, connRef2: string) => {
        const tenantClient = new PrismaClient({ datasourceUrl: connRef2 });
        try {
          return await indexTenantUsers(controlPlane, tenantId2, tenantClient);
        } finally {
          await tenantClient.$disconnect();
        }
      });
    const indexedUsers = await indexDirectory(id, connRef);

    // 5. Object storage (1.2.5). Best-effort: the school must be able to
    // exist without MinIO, so a storage failure is audited, not fatal.
    const provisionStorage =
      deps.provisionStorage ??
      ((slugToProvision: string) => provisionTenantStorageOrDefault(slugToProvision));
    let storage: TenantStorage | StorageSkipped;
    try {
      storage = await provisionStorage(slug);
    } catch (err) {
      // The MinIO SDK sometimes throws with an empty message (e.g. ECONNREFUSED
      // carried only on the code); include the code so the audit stays useful.
      const errMsg = (err as Error).message || (err as { code?: string }).code || 'unknown error';
      storage = {
        skipped: true,
        reason: `object storage provisioning failed (tenant still created): ${errMsg}`,
      };
      await audit(controlPlane, actor, 'tenant.storage.failed', id, {
        slug,
        error: errMsg,
      }).catch(() => undefined);
    }

    // 6. Datastore record + status.
    await controlPlane.tenantDatastore.create({
      data: { tenantId: id, kind: 'POSTGRES', connRef, schemaVersion: 1, lastMigratedAt: new Date() },
    });
    undo.push(async () => {
      await controlPlane.tenantDatastore.delete({ where: { tenantId: id } });
    });

    await audit(controlPlane, actor, 'tenant.provision.complete', id, {
      slug,
      database: dbName,
      schemaVersion: 1,
      adminUserId: seeded.adminUserId,
      indexedUsers,
      role: role?.roleName ?? null,
      storageSkipped: 'skipped' in storage ? storage.reason : undefined,
      storageBucket: 'bucket' in storage ? storage.bucket : undefined,
    });

    return {
      tenantId: id,
      slug,
      database: dbName,
      connRef,
      schemaVersion: 1,
      adminUserId: seeded.adminUserId,
      setupUrl: seeded.setupUrl,
      alreadyProvisioned: false,
      roleName: role?.roleName ?? null,
      indexedUsers,
      storage,
    };
  } catch (err) {
    // Record the rollback audit BEFORE the undo chain deletes the tenant row —
    // the audit's tenant FK must still be resolvable when the row is written.
    if (tenantId) {
      await audit(controlPlane, actor, 'tenant.provision.rollback', tenantId, {
        slug,
        error: (err as Error).message,
      }).catch(() => undefined);
    }
    // Roll back in reverse order, best effort.
    for (const fn of undo.reverse()) {
      try {
        await fn();
      } catch {
        // A failed rollback step is recorded; the audit trail is the source of truth.
      }
    }
    throw err;
  }
}