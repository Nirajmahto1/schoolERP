// ──────────────────────────────────────────────
// User-facing token lifecycle: rotation, reuse detection, revocation
//
// WHAT WAS WRONG BEFORE
//   • Access tokens lasted 7 days, refresh tokens 30 days.
//   • No `jti`, so no token could ever be individually revoked.
//   • Logout was cosmetic — it deleted the client's copy and nothing else.
//   • `/auth/refresh` re-signed the claims from the old token without
//     re-reading the user, so deactivating or demoting a user had no effect
//     for up to 30 days. A fired teacher kept working access.
//
// WHAT THIS DOES
//   • Access tokens: 15 minutes, carry a `jti`, checkable against a denylist.
//   • Refresh tokens: rotate on every use, stored HASHED, family-tracked.
//   • Reuse of an already-rotated refresh token revokes the entire family —
//     the standard response to a stolen-token replay (OAuth BCP).
//   • Logout revokes the family and denylists the live access token.
//   • Refresh REQUIRES a caller-supplied re-read of the user from the database.
// ──────────────────────────────────────────────

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import jwt, { SignOptions } from 'jsonwebtoken';
import { z } from 'zod';

export interface TokenStore {
  /** Persist a refresh record. `ttlSeconds` must expire it automatically. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
  /** Delete every key under a prefix — used to kill a token family. */
  delByPrefix(prefix: string): Promise<void>;
  /** Mark an access-token `jti` revoked until its natural expiry. */
  addToDenylist(jti: string, ttlSeconds: number): Promise<void>;
  isDenylisted(jti: string): Promise<boolean>;
}

export interface AccessTokenClaims {
  sub: string;
  email: string;
  /** Control-plane tenant id (routes to a database via @school-erp/tenant). */
  tenantId: string;
  /** School row id inside the tenant database (handlers' write key). */
  schoolId: string | null;
  branchId: string | null;
  roles: string[];
  jti: string;
  iat: number;
  exp: number;
}

const accessClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  tenantId: z.string().min(1),
  schoolId: z.string().min(1).nullable().default(null),
  branchId: z.string().nullable(),
  roles: z.array(z.string()).min(1),
  jti: z.string().min(1),
  iat: z.number(),
  exp: z.number(),
});

export interface TokenConfig {
  accessSecret: string;
  refreshSecret: string;
  /** e.g. `15m` */
  accessExpiresIn: string;
  /** e.g. `30d` */
  refreshExpiresIn: string;
}

/** The authoritative user state, re-read from the database on every refresh. */
export interface LiveUser {
  id: string;
  email: string;
  isActive: boolean;
  /** Control-plane tenant id (database routing key). */
  tenantId: string;
  /** School row id inside that database; equals tenantId in dev single-DB mode. */
  schoolId?: string | null;
  branchId: string | null;
  roles: string[];
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export class TokenError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'invalid'
      | 'expired'
      | 'revoked'
      | 'reused'
      | 'user-inactive'
      | 'user-missing',
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

// ── Key layout ──
// refresh:<userId>:<familyId>:<tokenId> -> JSON record
// denylist:<jti>                        -> "1"
const refreshKey = (userId: string, familyId: string, tokenId: string) =>
  `refresh:${userId}:${familyId}:${tokenId}`;
const familyPrefix = (userId: string, familyId: string) => `refresh:${userId}:${familyId}:`;
const userPrefix = (userId: string) => `refresh:${userId}:`;

interface RefreshRecord {
  userId: string;
  familyId: string;
  tokenId: string;
  /** SHA-256 of the raw token. We never store the token itself. */
  tokenHash: string;
  /** Set once the token has been exchanged. A second use is an attack signal. */
  usedAt: number | null;
  createdAt: number;
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function durationToSeconds(duration: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d|w|y)$/i.exec(duration.trim());
  if (!match) throw new Error(`Unparseable duration: ${duration}`);
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factors: Record<string, number> = {
    ms: 1 / 1000,
    s: 1,
    m: 60,
    h: 3600,
    d: 86_400,
    w: 604_800,
    y: 31_536_000,
  };
  return Math.floor(value * factors[unit]);
}

/**
 * Issue a fresh access + refresh pair, starting a new token family.
 *
 * Call on successful login. `familyId` groups every token descended from one
 * login event so a detected replay can revoke exactly that lineage — other
 * devices stay logged in.
 */
export async function issueTokenPair(
  user: LiveUser,
  config: TokenConfig,
  store: TokenStore,
  familyId: string = randomUUID(),
): Promise<TokenPair> {
  const accessTtl = durationToSeconds(config.accessExpiresIn);
  const refreshTtl = durationToSeconds(config.refreshExpiresIn);

  const accessOptions: SignOptions = {
    expiresIn: accessTtl,
    jwtid: randomUUID(),
  };
  const accessToken = jwt.sign(
    {
      sub: user.id,
      email: user.email,
      tenantId: user.tenantId,
      schoolId: user.schoolId ?? null,
      branchId: user.branchId,
      roles: user.roles,
    },
    config.accessSecret,
    accessOptions,
  );

  const tokenId = randomUUID();
  const rawRefresh = randomBytes(48).toString('base64url');
  const refreshToken = jwt.sign(
    { sub: user.id, familyId, tokenId, nonce: rawRefresh },
    config.refreshSecret,
    { expiresIn: refreshTtl },
  );

  const record: RefreshRecord = {
    userId: user.id,
    familyId,
    tokenId,
    tokenHash: hashToken(refreshToken),
    usedAt: null,
    createdAt: Date.now(),
  };
  await store.set(refreshKey(user.id, familyId, tokenId), JSON.stringify(record), refreshTtl);

  return { accessToken, refreshToken, expiresIn: accessTtl };
}

/**
 * Verify an access token: signature, then denylist.
 *
 * The denylist check is what makes logout and forced-revocation real. It costs
 * one Redis lookup per request, which is why the access TTL is short — a long
 * TTL would mean a large, long-lived denylist.
 */
export async function verifyAccessToken(
  token: string,
  config: TokenConfig,
  store: TokenStore,
): Promise<AccessTokenClaims> {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, config.accessSecret, { algorithms: ['HS256'] });
  } catch (err) {
    if ((err as Error).name === 'TokenExpiredError') {
      throw new TokenError('Access token has expired.', 'expired');
    }
    throw new TokenError('Access token is invalid.', 'invalid');
  }

  const parsed = accessClaimsSchema.safeParse(decoded);
  if (!parsed.success) throw new TokenError('Access token claims are malformed.', 'invalid');

  if (await store.isDenylisted(parsed.data.jti)) {
    throw new TokenError('Access token has been revoked.', 'revoked');
  }

  return parsed.data;
}

/**
 * Rotate a refresh token.
 *
 * `reloadUser` MUST hit the database. This is the fix for the demoted-user
 * problem: roles, tenant, branch, and active status all come from the live row,
 * never from the old token's claims.
 */
export async function rotateRefreshToken(
  presentedToken: string,
  config: TokenConfig,
  store: TokenStore,
  reloadUser: (userId: string) => Promise<LiveUser | null>,
): Promise<TokenPair> {
  let payload: { sub: string; familyId: string; tokenId: string };
  try {
    payload = jwt.verify(presentedToken, config.refreshSecret, {
      algorithms: ['HS256'],
    }) as typeof payload;
  } catch (err) {
    if ((err as Error).name === 'TokenExpiredError') {
      throw new TokenError('Refresh token has expired.', 'expired');
    }
    throw new TokenError('Refresh token is invalid.', 'invalid');
  }

  const { sub: userId, familyId, tokenId } = payload;
  if (!userId || !familyId || !tokenId) {
    throw new TokenError('Refresh token is malformed.', 'invalid');
  }

  const key = refreshKey(userId, familyId, tokenId);
  const stored = await store.get(key);

  if (!stored) {
    // The token verifies cryptographically but we have no record of it. Either
    // it was already rotated and pruned, or the family was revoked. Treat as
    // replay and burn the family.
    await store.delByPrefix(familyPrefix(userId, familyId));
    throw new TokenError(
      'Refresh token has already been used or was revoked. All sessions in this family are now invalid.',
      'reused',
    );
  }

  const record = JSON.parse(stored) as RefreshRecord;

  if (!constantTimeEqual(record.tokenHash, hashToken(presentedToken))) {
    await store.delByPrefix(familyPrefix(userId, familyId));
    throw new TokenError('Refresh token does not match its record.', 'invalid');
  }

  if (record.usedAt !== null) {
    // Definitive replay: this exact token was already exchanged. Someone has a
    // copy they should not have.
    await store.delByPrefix(familyPrefix(userId, familyId));
    throw new TokenError(
      'Refresh token reuse detected. All sessions in this family have been revoked.',
      'reused',
    );
  }

  const user = await reloadUser(userId);
  if (!user) {
    await store.delByPrefix(userPrefix(userId));
    throw new TokenError('User no longer exists.', 'user-missing');
  }
  if (!user.isActive) {
    await store.delByPrefix(userPrefix(userId));
    throw new TokenError('User account is inactive.', 'user-inactive');
  }

  // Consume the presented token, then mint the next one in the same family.
  await store.del(key);
  return issueTokenPair(user, config, store, familyId);
}

/** Revoke one session: burn its family and denylist the live access token. */
export async function revokeSession(
  accessToken: string | undefined,
  refreshToken: string | undefined,
  config: TokenConfig,
  store: TokenStore,
): Promise<void> {
  if (refreshToken) {
    try {
      const payload = jwt.verify(refreshToken, config.refreshSecret, {
        ignoreExpiration: true,
        algorithms: ['HS256'],
      }) as { sub: string; familyId: string };
      if (payload.sub && payload.familyId) {
        await store.delByPrefix(familyPrefix(payload.sub, payload.familyId));
      }
    } catch {
      // A malformed token on logout is not worth failing the request over.
    }
  }

  if (accessToken) {
    try {
      const claims = jwt.verify(accessToken, config.accessSecret, {
        ignoreExpiration: true,
        algorithms: ['HS256'],
      }) as { jti?: string; exp?: number };
      if (claims.jti && claims.exp) {
        const remaining = claims.exp - Math.floor(Date.now() / 1000);
        if (remaining > 0) await store.addToDenylist(claims.jti, remaining);
      }
    } catch {
      // Same reasoning as above.
    }
  }
}

/**
 * Revoke every session for a user, across all devices.
 *
 * Call on: password change, role change, deactivation, or suspected compromise.
 * Live access tokens still expire naturally within the access TTL — the short
 * TTL is what bounds that window.
 */
export async function revokeAllSessions(userId: string, store: TokenStore): Promise<void> {
  await store.delByPrefix(userPrefix(userId));
}
