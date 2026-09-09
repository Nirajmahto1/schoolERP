// ──────────────────────────────────────────────
// Tenant registry (BUILD_PLAN 1.3)
//
//   • resolveBySlug / resolveById  — control-plane lookup, cached 60s
//   • getClient / getClientFor     — a PrismaClient bound to ONE tenant's
//                                    database, from the LRU cache (ADR-2)
//   • runWithTenant                — bind the AsyncLocalStorage context, then
//                                    reject SUSPENDED/CHURNED/DELETING tenants
//
// The connection string flows from the control-plane `tenant_datastores`
// table; the tenant schema's client is @school-erp/database's PrismaClient.
// ──────────────────────────────────────────────

import { PrismaClient as ControlPlaneClient, type TenantStatus } from '@school-erp/control-plane';
import { PrismaClient } from '@school-erp/database';
import { MemoryTenantCache, type TenantCache } from './cache';
import { LruTenantClientCache, type TenantClientCache } from './client-cache';
import { NoTenantContextError, currentTenantId, runWithTenant as runWithTenantAls } from './context';

/** The piece of a tenant that services actually consume. */
export interface TenantRecord {
  tenantId: string;
  slug: string;
  status: TenantStatus;
  /** Encrypted conn reference in production; raw connection string for now. */
  connRef: string | null;
  schemaVersion: number;
}

export class TenantUnavailableError extends Error {
  constructor(
    readonly tenantId: string,
    readonly status: string,
  ) {
    super(`Tenant ${tenantId} is ${status} and cannot serve requests.`);
    this.name = 'TenantUnavailableError';
  }
}

const RESOLUTION_TTL_SECONDS = 60;

export interface TenantRegistryOptions {
  /** Control-plane client (the registry's source of truth). */
  controlPlane: ControlPlaneClient;
  /** Defaults to MemoryTenantCache(60s). Pass RedisTenantCache in prod. */
  cache?: TenantCache;
  /** Defaults to LruTenantClientCache(20, 10min). */
  clientCache?: TenantClientCache;
  /** Statuses that must not open a connection. */
  blockedStatuses?: TenantStatus[];
  /**
   * Connection string used when a tenant has NO datastore row yet — the seeded
   * single-database development setup (or the very first school before
   * provisioning ran). Refused in production: every real tenant must be in
   * the control-plane registry, not silently pointed at a shared database.
   */
  devFallbackConnRef?: string;
}

export class TenantRegistry {
  private readonly controlPlane: ControlPlaneClient;
  private readonly cache: TenantCache;
  private readonly clients: TenantClientCache;
  private readonly blocked: ReadonlySet<TenantStatus>;
  private readonly devFallbackConnRef?: string;

  constructor(options: TenantRegistryOptions) {
    this.controlPlane = options.controlPlane;
    this.cache = options.cache ?? new MemoryTenantCache(RESOLUTION_TTL_SECONDS);
    this.clients = options.clientCache ?? new LruTenantClientCache();
    this.blocked = new Set(options.blockedStatuses ?? ['SUSPENDED', 'CHURNED', 'DELETING']);
    if (options.devFallbackConnRef && process.env.NODE_ENV === 'production') {
      throw new Error(
        'devFallbackConnRef is refused in production — every tenant must resolve ' +
          'through the control-plane registry.',
      );
    }
    this.devFallbackConnRef = options.devFallbackConnRef;
  }

  private async fetch(where: { id?: string; slug?: string }): Promise<TenantRecord | null> {
    const tenant = await this.controlPlane.tenant.findUnique({
      where: where.id ? { id: where.id } : { slug: where.slug as string },
      include: { datastore: true },
    });
    if (!tenant) return null;
    return {
      tenantId: tenant.id,
      slug: tenant.slug,
      status: tenant.status,
      connRef: tenant.datastore?.connRef ?? null,
      schemaVersion: tenant.datastore?.schemaVersion ?? 0,
    };
  }

  /** Resolve a tenant by subdomain slug, cached for 60 seconds. */
  async resolveBySlug(slug: string): Promise<TenantRecord | null> {
    const key = `slug:${slug}`;
    const cached = await this.cache.get(key);
    if (cached) return JSON.parse(cached) as TenantRecord;
    const record = await this.fetch({ slug });
    if (record) await this.cache.set(key, JSON.stringify(record), RESOLUTION_TTL_SECONDS);
    return record;
  }

  /** Resolve a tenant by id, cached for 60 seconds. */
  async resolveById(tenantId: string): Promise<TenantRecord | null> {
    const key = `id:${tenantId}`;
    const cached = await this.cache.get(key);
    if (cached) return JSON.parse(cached) as TenantRecord;
    const record = await this.fetch({ id: tenantId });
    if (record) await this.cache.set(key, JSON.stringify(record), RESOLUTION_TTL_SECONDS);
    return record;
  }

  /**
   * A PrismaClient bound to the CURRENT tenant's database.
   *
   * Must be called inside a tenant context (see runWithTenant). This is the
   * runtime half of "a Prisma call outside a tenant context throws" — the
   * other half is services mounting the tenant middleware on every route.
   */
  async getClient(): Promise<PrismaClient> {
    const tenantId = currentTenantId();
    if (!tenantId) throw new NoTenantContextError();
    return this.getClientFor(tenantId);
  }

  /** A PrismaClient bound to an explicit tenant's database. */
  async getClientFor(tenantId: string): Promise<PrismaClient> {
    const record = await this.resolveById(tenantId);
    if (!record) {
      throw new Error(`Unknown tenant ${tenantId} — check the control-plane registry.`);
    }
    if (this.blocked.has(record.status)) {
      throw new TenantUnavailableError(tenantId, record.status);
    }
    if (!record.connRef) {
      // Dev escape hatch (see TenantRegistryOptions) — a tenant row may exist
      // before its datastore record in the seeded single-database setup.
      if (this.devFallbackConnRef) {
        return this.clients.get(tenantId, () => new PrismaClient({ datasourceUrl: this.devFallbackConnRef as string }));
      }
      throw new Error(`Tenant ${tenantId} has no datastore connection reference.`);
    }
    return this.clients.get(tenantId, () => new PrismaClient({ datasourceUrl: record.connRef as string }));
  }

  /**
   * Run `fn` with a tenant bound to the request context.
   *
   * Resolves the tenant first (unknown or blocked tenants throw before `fn`
   * runs), then binds the AsyncLocalStorage context for the call.
   */
  async runWithTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const record = await this.resolveById(tenantId);
    if (!record) throw new Error(`Unknown tenant ${tenantId} — cannot open a context.`);
    if (this.blocked.has(record.status)) {
      throw new TenantUnavailableError(tenantId, record.status);
    }
    return runWithTenantAls(tenantId, fn);
  }

  /** Forget a tenant's cached resolution — call after any tenant update. */
  async invalidate(tenantId: string, slug?: string): Promise<void> {
    await this.cache.invalidate(`id:${tenantId}`);
    if (slug) await this.cache.invalidate(`slug:${slug}`);
  }

  /** Number of live tenant clients in the LRU cache. */
  clientCount(): number {
    return this.clients.size();
  }

  /** Test/dev helper: disconnect and drop every cached client. */
  async close(): Promise<void> {
    await this.clients.clear();
  }
}