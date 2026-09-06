// ──────────────────────────────────────────────
// Redis-backed TokenStore (production)
//
// Deliberately typed against a minimal client interface rather than importing
// ioredis, so this package does not force a Redis client choice on every
// service that only needs to verify assertions.
// ──────────────────────────────────────────────

import type { TokenStore } from './tokens';

/** The subset of a Redis client this store needs. */
export interface RedisLike {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
  scan(
    cursor: string,
    match: 'MATCH',
    pattern: string,
    count: 'COUNT',
    count2: number,
  ): Promise<[string, string[]]>;
  exists(key: string): Promise<number>;
}

export class RedisTokenStore implements TokenStore {
  constructor(
    private readonly redis: RedisLike,
    /** Namespace so multiple environments can share a Redis instance safely. */
    private readonly prefix = 'erp',
  ) {}

  private k(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(this.k(key), value, 'EX', ttlSeconds);
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(this.k(key));
  }

  async del(key: string): Promise<void> {
    await this.redis.del(this.k(key));
  }

  /**
   * Delete every key under a prefix.
   *
   * Uses SCAN, never KEYS — KEYS blocks the Redis event loop for the duration
   * of the scan, which on a shared instance stalls every other service.
   */
  async delByPrefix(prefix: string): Promise<void> {
    const pattern = `${this.k(prefix)}*`;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) await this.redis.del(...keys);
    } while (cursor !== '0');
  }

  async addToDenylist(jti: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(this.k(`denylist:${jti}`), '1', 'EX', ttlSeconds);
  }

  async isDenylisted(jti: string): Promise<boolean> {
    return (await this.redis.exists(this.k(`denylist:${jti}`))) === 1;
  }
}
