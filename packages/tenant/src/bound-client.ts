// ──────────────────────────────────────────────
// Tenant-bound PrismaClient (BUILD_PLAN 1.3.6 / GATE 1)
//
// "A Prisma call with no tenant context throws."
//
// A Proxy that looks like a PrismaClient but routes EVERY model call to the
// client of the tenant bound in the current AsyncLocalStorage context
// (withTenant middleware). Services keep writing `prisma.student.findMany()`;
// the call lands on the right school's database or throws. There is no code
// path that queries "the" database without a tenant — the class of bug that
// leaks School A's marks to School B becomes unrepresentable.
//
// Inside `$transaction(callback)` the callback receives the REAL tenant client,
// so interactive transactions keep working.
// ──────────────────────────────────────────────

import type { PrismaClient } from '@school-erp/database';
import { NoTenantContextError, currentTenantId } from './context';
import type { TenantRegistry } from './registry';

/** Resolve the tenant client for the current ALS context, or throw. */
async function currentClient(registry: TenantRegistry): Promise<PrismaClient> {
  const tenantId = currentTenantId();
  if (!tenantId) throw new NoTenantContextError();
  return registry.getClientFor(tenantId);
}

/** Methods handled at the top level, without a tenant context. */
const TOP_LEVEL: Record<string, (registry: TenantRegistry, args: unknown[]) => unknown> = {
  $connect: () => undefined,
  $disconnect: (registry) => registry.close(),
  $on: () => undefined,
  $use: () => undefined,
  $extends: () => undefined,
};

/**
 * Build the tenant-bound client. One per service process; safe to share
 * across requests because every call resolves the context independently.
 */
export function createTenantBoundPrisma(registry: TenantRegistry): PrismaClient {
  const modelCache = new Map<string, unknown>();

  function modelDelegate(model: string): unknown {
    const cached = modelCache.get(model);
    if (cached) return cached;

    const delegate = new Proxy(Object.create(null), {
      get(_t, method: string) {
        return (...args: unknown[]) =>
          currentClient(registry).then((client) => {
            const target = (client as unknown as Record<string, unknown>)[model] as Record<string, unknown>;
            const fn = target[method];
            if (typeof fn !== 'function') {
              throw new Error(`Prisma model ${model} has no method ${method}.`);
            }
            return fn.apply(target, args);
          });
      },
    });
    modelCache.set(model, delegate);
    return delegate;
  }

  const bound = new Proxy(Object.create(null), {
    get(_t, prop: string) {
      const topLevel = TOP_LEVEL[prop];
      if (topLevel) {
        return (...args: unknown[]) => topLevel(registry, args);
      }

      // $-prefixed internals ($queryRaw, $executeRaw, $transaction, ...) run
      // against the current tenant's client.
      if (prop.startsWith('$')) {
        return (...args: unknown[]) =>
          currentClient(registry).then((client) => {
            const fn = (client as unknown as Record<string, unknown>)[prop] as (
              ...a: unknown[]
            ) => unknown;
            return fn.apply(client, args);
          });
      }

      // Prisma's per-model delegates and everything else.
      return modelDelegate(prop);
    },
  });

  return bound as unknown as PrismaClient;
}
