// ──────────────────────────────────────────────
// Provisioning environment (BUILD_PLAN 1.2)
//
// The provisioning CLI needs three URLs:
//   • CONTROL_PLANE_DATABASE_URL — the platform registry DB
//   • DATABASE_URL               — a school database the federation pattern is
//     anchored to. Used to derive a maintenance ("postgres") URL for
//     CREATE/DROP DATABASE, and as the template for per-tenant datastores.
//   • PROVISIONING_ADMIN_DATABASE_URL (optional) — override for the admin URL.
// ──────────────────────────────────────────────

import { loadDotenv } from '@school-erp/config';

export interface ProvisioningEnv {
  controlPlaneUrl: string;
  adminDatabaseUrl: string;
  /** OUR GSTIN — printed on every SaaS tax invoice (Rule 46, CGST Rules). */
  supplierGstin?: string;
  /** Supplier legal name as it must appear on tax invoices. */
  supplierName?: string;
  /** Supplier registered address as it must appear on tax invoices. */
  supplierAddress?: string;
}

export function loadProvisioningEnv(env: NodeJS.ProcessEnv = process.env): ProvisioningEnv {
  loadDotenv();

  const controlPlaneUrl = env.CONTROL_PLANE_DATABASE_URL;
  if (!controlPlaneUrl) {
    throw new Error('CONTROL_PLANE_DATABASE_URL is required (see .env.example).');
  }

  const databaseUrl = env.DATABASE_URL;
  const adminOverride = env.PROVISIONING_ADMIN_DATABASE_URL;
  let adminDatabaseUrl: string;

  if (adminOverride) {
    adminDatabaseUrl = adminOverride;
  } else if (databaseUrl) {
    adminDatabaseUrl = toMaintenanceUrl(databaseUrl);
  } else {
    throw new Error('DATABASE_URL is required to derive the maintenance/admin URL.');
  }

  return {
    controlPlaneUrl,
    adminDatabaseUrl,
    // Tax-invoice supplier identity (Rule 46). Optional at dev time; the
    // convert/renew commands warn when missing because invoices issued
    // without the supplier's GSTIN are not valid tax invoices.
    supplierGstin: env.SUPPLIER_GSTIN?.trim() || undefined,
    supplierName: env.SUPPLIER_NAME?.trim() || undefined,
    supplierAddress: env.SUPPLIER_ADDRESS?.trim() || undefined,
  };
}

/**
 * Turn a postgres URL for one database into one for the cluster's maintenance
 * database (`postgres`) so we can run CREATE/DROP DATABASE. Preserves
 * credentials and hashed passwords verbatim.
 */
export function toMaintenanceUrl(url: string): string {
  const match = url.match(/^(postgres(?:ql)?:\/\/[^/]+)\/([^/?]+)(.*)$/) as
    | RegExpMatchArray
    | null;
  if (!match) throw new Error(`Cannot derive a maintenance URL from: ${url}`);
  return `${match[1]}/postgres${match[3] ?? ''}`;
}

/**
 * Build the connection reference for a new tenant database from a template
 * tenant URL (e.g. the maintenance or DATABASE_URL) and a database name.
 */
export function tenantConnectionRef(templateUrl: string, databaseName: string): string {
  const match = templateUrl.match(/^(postgres(?:ql)?:\/\/[^/]+)\/([^/?]+)(.*)$/) as
    | RegExpMatchArray
    | null;
  if (!match) throw new Error(`Cannot build a tenant URL from: ${templateUrl}`);
  // Keep the original schema param (usually public) and any query params.
  const query = match[3] ?? '';
  const schemaParam = /\?schema=/.test(query) ? query : '?schema=public';
  return `${match[1]}/${databaseName}${schemaParam}`;
}

/** A safe lowercase database identifier derived from a slug. */
export function tenantDatabaseName(slug: string): string {
  // Postgres identifiers can't exceed 63 bytes and can't contain uppercase.
  return `tenant_${slug.replace(/-/g, '_')}`.slice(0, 63);
}