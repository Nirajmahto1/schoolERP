// ──────────────────────────────────────────────
// Per-tenant PrismaClient cache (ADR-2)
//
// 12 services × 50 tenants × Prisma's default pool would exhaust Postgres's
// connection budget. Every service process keeps at most `max` live tenant
// clients, evicting least-recently-used and disconnecting clients idle past
// `idleMs` — an explicit `$disconnect()` so Postgres actually gets the
// connections back.
// ──────────────────────────────────────────────

import type { PrismaClient } from '@school-erp/database';

interface Entry {
  client: PrismaClient;
  lastUsed: number;
}

export interface TenantClientCache {
  get(tenantId: string, factory: () => PrismaClient): PrismaClient;
  has(tenantId: string): boolean;
  size(): number;
  /** Disconnect and drop clients idle past the threshold. Returns how many. */
  evictIdle(): number;
  clear(): Promise<void>;
}

export class LruTenantClientCache implements TenantClientCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly max = 20,
    private readonly idleMs = 10 * 60_000,
  ) {}

  get(tenantId: string, factory: () => PrismaClient): PrismaClient {
    const now = Date.now();
    const hit = this.entries.get(tenantId);
    if (hit) {
      hit.lastUsed = now;
      // Re-insert to keep Map iteration order = recency order.
      this.entries.delete(tenantId);
      this.entries.set(tenantId, hit);
      return hit.client;
    }

    this.evictIdle();

    if (this.entries.size >= this.max) {
      // Map preserves insertion order, so the first key is the least recent.
      const oldestId = this.entries.keys().next().value as string;
      const evicted = this.entries.get(oldestId);
      this.entries.delete(oldestId);
      void evicted?.client.$disconnect();
    }

    const client = factory();
    this.entries.set(tenantId, { client, lastUsed: now });
    return client;
  }

  has(tenantId: string): boolean {
    return this.entries.has(tenantId);
  }

  size(): number {
    return this.entries.size;
  }

  evictIdle(): number {
    const now = Date.now();
    let evicted = 0;
    for (const [tenantId, entry] of this.entries) {
      if (now - entry.lastUsed > this.idleMs) {
        this.entries.delete(tenantId);
        void entry.client.$disconnect();
        evicted += 1;
      }
    }
    return evicted;
  }

  async clear(): Promise<void> {
    for (const entry of this.entries.values()) {
      await entry.client.$disconnect();
    }
    this.entries.clear();
  }
}