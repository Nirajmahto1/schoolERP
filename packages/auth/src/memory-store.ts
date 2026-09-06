// ──────────────────────────────────────────────
// In-memory TokenStore
//
// For tests and local single-process development only. Production uses the
// Redis-backed store so that revocation is shared across gateway instances —
// an in-memory denylist in a multi-instance deployment silently fails to revoke.
// ──────────────────────────────────────────────

import type { TokenStore } from './tokens';

interface Entry {
  value: string;
  expiresAt: number;
}

export class MemoryTokenStore implements TokenStore {
  private readonly entries = new Map<string, Entry>();
  private readonly denylist = new Map<string, number>();

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    for (const [jti, expiresAt] of this.denylist) {
      if (expiresAt <= now) this.denylist.delete(jti);
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async get(key: string): Promise<string | null> {
    this.sweep();
    return this.entries.get(key)?.value ?? null;
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async delByPrefix(prefix: string): Promise<void> {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  async addToDenylist(jti: string, ttlSeconds: number): Promise<void> {
    this.denylist.set(jti, Date.now() + ttlSeconds * 1000);
  }

  async isDenylisted(jti: string): Promise<boolean> {
    this.sweep();
    return this.denylist.has(jti);
  }

  /** Test helper: how many refresh records currently exist. */
  size(): number {
    this.sweep();
    return this.entries.size;
  }
}
