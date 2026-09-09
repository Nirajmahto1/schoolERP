// ──────────────────────────────────────────────
// Tenant request context (BUILD_PLAN 1.3.5)
//
// AsyncLocalStorage keeps the active tenant bound for the duration of one
// request, so no function signature needs threading. `getClient()` reads it;
// a query without a tenant bound is a bug that must throw, never silently
// run against an arbitrary database.
// ──────────────────────────────────────────────

import { AsyncLocalStorage } from 'node:async_hooks';

interface TenantContext {
  tenantId: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

/** Bind `fn` to a tenant for the duration of its call (and all awaits inside). */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return storage.run({ tenantId }, fn);
}

/** The active tenant id, or null when no tenant context is bound. */
export function currentTenantId(): string | null {
  return storage.getStore()?.tenantId ?? null;
}

export class NoTenantContextError extends Error {
  constructor() {
    super(
      'No tenant context is bound. Wrap the request in runWithTenant() (or the ' +
        'registry runWithTenant helper) before touching tenant data — a Prisma ' +
        'call outside a tenant context must never run.',
    );
    this.name = 'NoTenantContextError';
  }
}