// ──────────────────────────────────────────────
// Least-privilege tenant roles (BUILD_PLAN 1.2.2)
//
// "CREATE DATABASE tenant_<slug> + a least-privilege role per tenant (no
// superuser, no cross-DB read)."
//
// Each school database gets its own login role that OWNS that database and
// nothing else. The connection reference stored in `tenant_datastores` then
// carries the tenant role's credentials — never the cluster superuser — so a
// leaked tenant connection string is scoped to exactly one school: it cannot
// read a sibling school's database, cannot create databases, and cannot touch
// the control plane.
//
// Passwords are 32-byte random, returned once, and stored only inside the
// connRef (which Phase 11/12 upgrades to KMS encryption).
// ──────────────────────────────────────────────

import { randomBytes } from 'crypto';
import { PrismaClient } from '@school-erp/database';

const IDENT_MAX = 63;

/** Postgres identifier length limit (bytes) with the tenant_ prefix reserved. */
export function safeRoleName(slug: string): string {
  return `tenant_${slug.replace(/-/g, '_')}_app`.slice(0, IDENT_MAX);
}

/** Quote a Postgres identifier safely (doubles embedded quotes). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export interface TenantRole {
  roleName: string;
  password: string;
}

/**
 * Create (or reset) the tenant's application role and hand it ownership of the
 * database plus full rights on the public schema. Idempotent: an existing role
 * gets a fresh password (so re-running provisioning after a partial failure
 * still converges) and re-grants.
 */
export async function createTenantRole(
  adminUrl: string,
  dbName: string,
  slug: string,
): Promise<TenantRole> {
  const roleName = safeRoleName(slug);
  const password = randomBytes(32).toString('base64url');
  const admin = new PrismaClient({ datasourceUrl: adminUrl });

  try {
    // The role is cluster-level: create it on the maintenance connection.
    await admin.$executeRawUnsafe(
      `DO $$
BEGIN
   IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quote(roleName)}) THEN
      CREATE ROLE ${quoteIdent(roleName)} LOGIN PASSWORD '${password.replace(/'/g, "''")}';
   ELSE
      ALTER ROLE ${quoteIdent(roleName)} LOGIN PASSWORD '${password.replace(/'/g, "''")}';
   END IF;
END
$$;`,
    );

    // Ownership + schema rights, granted from inside the tenant database.
    const tenantDbUrl = adminUrl.replace(/\/postgres(\?|$)/, `/${dbName}$1`);
    const onTenant = new PrismaClient({ datasourceUrl: tenantDbUrl });
    try {
      await onTenant.$executeRawUnsafe(`ALTER DATABASE ${quoteIdent(dbName)} OWNER TO ${quoteIdent(roleName)}`);
      await onTenant.$executeRawUnsafe(`GRANT ALL ON SCHEMA public TO ${quoteIdent(roleName)}`);
      await onTenant.$executeRawUnsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${quoteIdent(roleName)}`);
      await onTenant.$executeRawUnsafe(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdent(roleName)}`);
      await onTenant.$executeRawUnsafe(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${quoteIdent(roleName)}`,
      );
      await onTenant.$executeRawUnsafe(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${quoteIdent(roleName)}`,
      );
    } finally {
      await onTenant.$disconnect();
    }

    return { roleName, password };
  } finally {
    await admin.$disconnect();
  }
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Revoke and drop the tenant's role. Best effort: ownership is reassigned to
 * the admin role first, otherwise DROP ROLE fails on owned objects.
 */
export async function dropTenantRole(
  adminUrl: string,
  dbName: string,
  slug: string,
): Promise<void> {
  const roleName = safeRoleName(slug);
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    const exists = await admin.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${roleName}) AS exists`;
    if (!exists[0]?.exists) return;

    const tenantDbUrl = adminUrl.replace(/\/postgres(\?|$)/, `/${dbName}$1`);
    const onTenant = new PrismaClient({ datasourceUrl: tenantDbUrl });
    try {
      // Reassign owned objects to the connected (admin) role, drop privileges.
      await onTenant.$executeRawUnsafe(
        `REASSIGN OWNED BY ${quoteIdent(roleName)} TO CURRENT_USER`,
      ).catch(() => undefined);
      await onTenant.$executeRawUnsafe(
        `DROP OWNED BY ${quoteIdent(roleName)}`,
      ).catch(() => undefined);
    } finally {
      await onTenant.$disconnect();
    }

    await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${quoteIdent(roleName)}`);
  } finally {
    await admin.$disconnect();
  }
}

/**
 * Build the connection string the way the tenant role would use it. The
 * datastore connRef should ALWAYS be built from this, never from the admin
 * credentials.
 */
export function tenantRoleConnRef(
  adminUrl: string,
  dbName: string,
  role: TenantRole,
): string {
  // Preserve host:port and query string from the admin URL, swap credentials
  // and database. Parsing with a regex keeps this dependency-free.
  const match = adminUrl.match(/^(postgres(?:ql)?:\/\/)([^@/]+)@([^/]+)\/([^/?]+)(\?.*)?$/);
  if (!match) throw new Error(`Cannot derive a tenant connRef from the admin URL shape.`);
  const [, scheme, , hostPort, , query] = match;
  return `${scheme}${encodeURIComponent(role.roleName)}:${encodeURIComponent(role.password)}@${hostPort}/${dbName}${query ?? '?schema=public'}`;
}

/** Unused-import guard: PrismaClient is used via type inference in raw calls. */
export type { PrismaClient };
