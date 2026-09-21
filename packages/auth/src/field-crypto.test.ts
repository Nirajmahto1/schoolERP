// ──────────────────────────────────────────────
// Field encryption tests (Phase 12.5)
// ──────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { encryptField, decryptField, isEncryptedField } from './field-crypto';

describe('field crypto (AES-256-GCM envelopes)', () => {
  it('roundtrips a phone number', () => {
    const enc = encryptField('+91 98765 43210');
    expect(enc).toMatch(/^v1:primary:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(decryptField(enc)).toBe('+91 98765 43210');
  });

  it('produces a different envelope every write (random IV)', () => {
    expect(encryptField('same')).not.toBe(encryptField('same'));
  });

  it('detects tampered ciphertext instead of returning garbage', () => {
    const enc = encryptField('medical note');
    const parts = enc!.split(':');
    parts[4] = Buffer.from('tampered').toString('base64');
    expect(() => decryptField(parts.join(':'))).toThrow(/decryption failed/);
  });

  it('detects tampered auth tag', () => {
    const enc = encryptField('safeguarding note');
    const parts = enc!.split(':');
    const tag = Buffer.from(parts[3], 'base64');
    tag[0] ^= 0xff;
    parts[3] = tag.toString('base64');
    expect(() => decryptField(parts.join(':'))).toThrow(/decryption failed/);
  });

  it('passes legacy plaintext through untouched (migration window)', () => {
    expect(decryptField('+91 12345 67890')).toBe('+91 12345 67890');
    expect(isEncryptedField('+91 12345 67890')).toBe(false);
  });

  it('null/empty stays null', () => {
    expect(encryptField(null)).toBeNull();
    expect(decryptField(null)).toBeNull();
    expect(decryptField('')).toBeNull();
  });

  it('isEncryptedField recognises envelopes', () => {
    expect(isEncryptedField(encryptField('x'))).toBe(true);
  });

  it('decrypts with an explicit key id after rotation', () => {
    process.env.FIELD_CRYPTO_KEY = Buffer.alloc(32, 7).toString('base64');
    const old = encryptField('pre-rotation value');

    // Rotate: new id + new key; old envelope must still open because the id
    // rides in the envelope... but the old key was named 'primary'. Re-set it
    // under its new name and rotate the pointer.
    process.env.FIELD_CRYPTO_KEY_PRIMARY = process.env.FIELD_CRYPTO_KEY;
    process.env.FIELD_CRYPTO_KEY = Buffer.alloc(32, 9).toString('base64');
    process.env.FIELD_CRYPTO_KEY_ID = 'rotated-2026';

    const fresh = encryptField('post-rotation value');
    expect(fresh).toContain('v1:rotated-2026:');
    expect(decryptField(fresh)).toBe('post-rotation value');
    expect(decryptField(old)).toBe('pre-rotation value');

    delete process.env.FIELD_CRYPTO_KEY_ID;
    delete process.env.FIELD_CRYPTO_KEY_PRIMARY;
  });
});
