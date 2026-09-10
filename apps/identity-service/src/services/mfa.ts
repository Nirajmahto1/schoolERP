// ──────────────────────────────────────────────
// MFA challenge tokens + role policy (BUILD_PLAN 2.1.5 / 3.1)
//
// Step 1 of an MFA login returns a SHORT-LIVED signed token (5 minutes) that
// carries only the user id and an `mfa-challenge` type. It is not an access
// token: it carries no roles, no tenant, and is only accepted by
// /auth/mfa/verify. This keeps the half-authenticated state from being
// replayable against any other route.
// ──────────────────────────────────────────────

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

const CHALLENGE_TTL_SECONDS = 5 * 60;

/** Thrown when a challenge fails verification or is replayed. */
export class ChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChallengeError';
  }
}

/** Roles that must present a TOTP code once enrolled. */
const MFA_ROLES = new Set(['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'FINANCE', 'ACCOUNTANT']);

export function mfaRequiredForRoles(roles: string[]): boolean {
  return roles.some((r) => MFA_ROLES.has(r));
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Sign a challenge token. Deliberately HS256-over-JSON rather than the JWT
 * library: a distinct format cannot be confused with an access token by any
 * code path that verifies the latter. The random `cid` makes the challenge
 * single-use when the verifier records it in a store.
 */
export function signMfaChallenge(
  userId: string,
  secret: string,
  now = Date.now(),
): { token: string; cid: string } {
  const cid = randomUUID();
  const payload = b64url(
    JSON.stringify({ t: 'mfa-challenge', sub: userId, cid, iat: now, exp: now + CHALLENGE_TTL_SECONDS * 1000 }),
  );
  return { token: `${payload}.${hmac(secret, payload)}`, cid };
}

/**
 * Verify a challenge and mark it consumed via `store` (single-use). Replaying
 * a used challenge throws — the flow must start over.
 */
export async function verifyMfaChallenge(
  token: string,
  secret: string,
  store: { get(key: string): Promise<string | null>; set(key: string, value: string, ttlSeconds: number): Promise<void> },
): Promise<string> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) throw new ChallengeError('malformed challenge');
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = hmac(secret, payload);
  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ChallengeError('bad challenge signature');

  let parsed: { t?: string; sub?: string; cid?: string; exp?: number };
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new ChallengeError('malformed challenge');
  }
  if (parsed.t !== 'mfa-challenge' || !parsed.sub || !parsed.cid) throw new ChallengeError('not a challenge token');
  if (!parsed.exp || parsed.exp < Date.now()) throw new ChallengeError('challenge expired');

  const usedKey = `mfa-challenge:${parsed.cid}`;
  if ((await store.get(usedKey)) !== null) {
    throw new ChallengeError('challenge already used');
  }
  await store.set(usedKey, '1', CHALLENGE_TTL_SECONDS);
  return parsed.sub;
}
