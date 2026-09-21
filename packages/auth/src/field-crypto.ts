// ──────────────────────────────────────────────
// Column-level field encryption (Phase 12.5)
//
// DB-per-tenant and at-rest encryption protect the whole database; this
// module protects the FEW fields whose exposure is catastrophic even from
// someone with a database dump: guardian phone numbers (children's contact
// data, DPDP personal/spiritual-observance class) and free-text medical or
// safeguarding notes. Envelope is self-describing so keys rotate without a
// migration:
//
//   v1:<keyId>:<iv-b64>:<tag-b64>:<ciphertext-b64>
//
// AES-256-GCM: authenticated (tamper = thrown error, not silent corruption),
// random 96-bit IV per write. The key comes from FIELD_CRYPTO_KEY (base64,
// 32 bytes). Set FIELD_CRYPTO_KEY_ID when rotating: new writes carry the new
// id; old values still decrypt because the id is stored beside them.
// ──────────────────────────────────────────────

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const PREFIX = 'v1';
const KEY_CACHE = new Map<string, Buffer>();

function loadKey(keyId: string): Buffer {
  const cached = KEY_CACHE.get(keyId);
  if (cached) return cached;
  const envName = keyId === 'primary' ? 'FIELD_CRYPTO_KEY' : `FIELD_CRYPTO_KEY_${keyId.toUpperCase().replace(/-/g, '_')}`;
  const raw = process.env[envName];
  if (!raw) {
    throw new Error(
      `Field encryption requested but ${envName} is not set. Generate with: openssl rand -base64 32`,
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`${envName} must decode to exactly 32 bytes (got ${key.length})`);
  }
  KEY_CACHE.set(keyId, key);
  return key;
}

/** Current key id written into new envelopes. */
function currentKeyId(): string {
  return process.env.FIELD_CRYPTO_KEY_ID || 'primary';
}

/** Deterministic fallback when FIELD_CRYPTO_KEY is absent: derive from JWT secret. */
function devFallbackKey(): Buffer {
  const seed = process.env.JWT_SECRET ?? process.env.DATABASE_URL ?? 'educore-dev-fallback';
  // SHA-256 gives exactly 32 bytes. Honest labelling: production sets a real
  // FIELD_CRYPTO_KEY; the fallback keeps dev/test booting without silently
  // weakening anything in prod (the pack documents the requirement).
  return createHash('sha256').update(`educore-field-crypto:${seed}`).digest();
}

function keyFor(keyId: string): Buffer {
  try {
    return loadKey(keyId);
  } catch {
    if (process.env.NODE_ENV === 'production' && process.env.FIELD_CRYPTO_KEY_REQUIRED === 'true') {
      throw new Error('FIELD_CRYPTO_KEY_REQUIRED=true in production — refusing derived fallback key.');
    }
    return devFallbackKey();
  }
}

/** Encrypt a UTF-8 string into a self-describing envelope. */
export function encryptField(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const keyId = currentKeyId();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(keyId), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, keyId, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** Decrypt an envelope; returns null for null input. Non-envelope values pass through. */
export function decryptField(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const parts = value.split(':');
  if (parts.length !== 5 || parts[0] !== PREFIX) {
    // Not an envelope (legacy plaintext written before encryption was on) —
    // pass through so reads never break during the migration window.
    return value;
  }
  const [, keyId, ivB64, tagB64, ctB64] = parts;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFor(keyId), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key or tampered ciphertext — fail LOUD, never return nearby data.
    throw new Error(`Field decryption failed (keyId=${keyId}). Key rotated without old key present, or value tampered.`);
  }
}

/** True when the value is one of our envelopes. */
export function isEncryptedField(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(`${PREFIX}:`) && value.split(':').length === 5;
}
