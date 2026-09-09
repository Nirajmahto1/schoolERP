// ──────────────────────────────────────────────
// Tenant resolution cache (BUILD_PLAN 1.3.2)
//
// slug → tenant is cached for 60s with explicit invalidation on tenant update.
// In-memory by default (single process); RedisTenantCache shares the cache
// across gateway instances. Typed against a minimal RedisLike interface, the
// same pattern as @school-erp/auth's RedisTokenStore.
// ──────────────────────────────────────────────

export interface TenantCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Forget one key — call after a tenant update so the next request sees it. */
  invalidate(key: string): Promise<void>;
}

interface Entry {
  value: string;
  expiresAt: number;
}

/** Single-process cache. Evicts lazily on read, eagerly on write. */
export class MemoryTenantCache implements TenantCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly defaultTtlSeconds = 60) {}

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? this.defaultTtlSeconds;
    this.entries.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
  }

  async invalidate(key: string): Promise<void> {
    this.entries.delete(key);
  }

  size(): number {
    return this.entries.size;
  }
}

/** The subset of a Redis client this cache needs. */
export interface RedisLike {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

/** Shared, multi-instance cache. Keys are namespaced per environment. */
export class RedisTenantCache implements TenantCache {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix = 'erp:tenant',
  ) {}

  private k(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(this.k(key));
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(this.k(key), value, 'EX', ttlSeconds);
  }

  async invalidate(key: string): Promise<void> {
    await this.redis.set(this.k(key), '', 'EX', 1);
  }
}