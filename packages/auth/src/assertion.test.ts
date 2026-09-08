import { generateKeyPairSync } from 'crypto';
import jwt from 'jsonwebtoken';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AssertionError,
  INTERNAL_ASSERTION_HEADER,
  SPOOFABLE_IDENTITY_HEADERS,
  mintAssertion,
  verifyAssertion,
} from './assertion';

let privateKey: string;
let publicKey: string;
let otherPublicKey: string;
let otherPrivateKey: string;

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  otherPrivateKey = other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  otherPublicKey = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
});

const baseInput = {
  userId: 'usr_1',
  email: 'principal@dps.test',
  tenantId: 'tnt_dps',
  branchId: 'brn_noida',
  roles: ['PRINCIPAL'],
  permissions: ['students.read', 'marks.publish'],
  audience: 'student-service',
};

const signer = () => ({ privateKey, ttlSeconds: 60 });

describe('mint → verify round trip', () => {
  it('returns the trusted context', () => {
    const token = mintAssertion(baseInput, signer());
    const context = verifyAssertion(token, publicKey, 'student-service');

    expect(context).toMatchObject({
      userId: 'usr_1',
      email: 'principal@dps.test',
      tenantId: 'tnt_dps',
      branchId: 'brn_noida',
      roles: ['PRINCIPAL'],
      permissions: ['students.read', 'marks.publish'],
      impersonatedBy: null,
    });
    expect(context.assertionId).toBeTruthy();
  });

  it('gives every assertion a distinct jti', () => {
    const a = verifyAssertion(mintAssertion(baseInput, signer()), publicKey, 'student-service');
    const b = verifyAssertion(mintAssertion(baseInput, signer()), publicKey, 'student-service');
    expect(a.assertionId).not.toBe(b.assertionId);
  });

  it('carries impersonation for audited support access', () => {
    const token = mintAssertion(
      { ...baseInput, impersonatedBy: 'padm_9' },
      signer(),
    );
    expect(verifyAssertion(token, publicKey, 'student-service').impersonatedBy).toBe('padm_9');
  });
});

// ── The vulnerability this package exists to close ──
describe('forged credentials are rejected', () => {
  it('rejects a request with no assertion at all', () => {
    expect(() => verifyAssertion(undefined, publicKey, 'student-service')).toThrow(
      AssertionError,
    );
    try {
      verifyAssertion(undefined, publicKey, 'student-service');
    } catch (e) {
      expect((e as AssertionError).reason).toBe('missing');
    }
  });

  it('rejects an assertion signed by an unknown key', () => {
    const forged = mintAssertion(
      { ...baseInput, roles: ['SUPER_ADMIN'] },
      { privateKey: otherPrivateKey, ttlSeconds: 60 },
    );
    expect(() => verifyAssertion(forged, publicKey, 'student-service')).toThrow(AssertionError);
  });

  it('rejects an unsigned (alg=none) token claiming SUPER_ADMIN', () => {
    const unsigned = jwt.sign(
      {
        sub: 'attacker',
        email: 'a@evil.test',
        tenantId: 'tnt_victim',
        roles: ['SUPER_ADMIN'],
        jti: 'x',
      },
      '',
      { algorithm: 'none' } as jwt.SignOptions,
    );
    expect(() => verifyAssertion(unsigned, publicKey, 'student-service')).toThrow(AssertionError);
  });

  it('rejects an HMAC-signed token even if the attacker guesses the public key as the secret', () => {
    // Classic algorithm-confusion attack: sign with HS256 using the PEM public
    // key as the shared secret. Pinning `algorithms: ['RS256']` defeats it.
    const confused = jwt.sign(
      {
        sub: 'attacker',
        email: 'a@evil.test',
        tenantId: 'tnt_victim',
        roles: ['SUPER_ADMIN'],
        jti: 'x',
      },
      publicKey,
      { algorithm: 'HS256', issuer: 'school-erp-gateway', audience: 'student-service' },
    );
    expect(() => verifyAssertion(confused, publicKey, 'student-service')).toThrow(AssertionError);
  });

  it('rejects an assertion minted for a different service (no replay across services)', () => {
    const forFees = mintAssertion({ ...baseInput, audience: 'fee-service' }, signer());
    expect(() => verifyAssertion(forFees, publicKey, 'student-service')).toThrow(AssertionError);
    try {
      verifyAssertion(forFees, publicKey, 'student-service');
    } catch (e) {
      expect((e as AssertionError).reason).toBe('wrong-audience');
    }
  });

  it('rejects an expired assertion', () => {
    const expired = mintAssertion(baseInput, { privateKey, ttlSeconds: -30 });
    try {
      verifyAssertion(expired, publicKey, 'student-service');
      throw new Error('expected rejection');
    } catch (e) {
      expect((e as AssertionError).reason).toBe('expired');
    }
  });

  it('rejects a token issued by something other than the gateway', () => {
    const wrongIssuer = jwt.sign(
      { sub: 'u', email: 'a@b.test', tenantId: 't', roles: ['TEACHER'] },
      privateKey,
      { algorithm: 'RS256', issuer: 'not-the-gateway', audience: 'student-service', expiresIn: 60, jwtid: 'j' },
    );
    expect(() => verifyAssertion(wrongIssuer, publicKey, 'student-service')).toThrow(
      AssertionError,
    );
  });

  it('rejects a validly-signed assertion whose claims are malformed', () => {
    const missingTenant = jwt.sign(
      { sub: 'u', email: 'a@b.test', roles: ['TEACHER'] },
      privateKey,
      { algorithm: 'RS256', issuer: 'school-erp-gateway', audience: 'student-service', expiresIn: 60, jwtid: 'j' },
    );
    try {
      verifyAssertion(missingTenant, publicKey, 'student-service');
      throw new Error('expected rejection');
    } catch (e) {
      expect((e as AssertionError).reason).toBe('malformed');
    }
  });

  it('rejects an assertion with an empty roles array', () => {
    const noRoles = jwt.sign(
      { sub: 'u', email: 'a@b.test', tenantId: 't', roles: [] },
      privateKey,
      { algorithm: 'RS256', issuer: 'school-erp-gateway', audience: 'student-service', expiresIn: 60, jwtid: 'j' },
    );
    expect(() => verifyAssertion(noRoles, publicKey, 'student-service')).toThrow(AssertionError);
  });
});

describe('SPOOFABLE_IDENTITY_HEADERS', () => {
  it('covers every identity header the old gateway trusted', () => {
    // These are the exact headers api-gateway/src/middleware/auth.ts used to set
    // and every downstream service used to read.
    for (const legacy of [
      'x-user-id',
      'x-user-email',
      'x-user-role',
      'x-branch-id',
      'x-school-id',
    ]) {
      expect(SPOOFABLE_IDENTITY_HEADERS).toContain(legacy);
    }
  });

  it('does NOT strip the assertion header on the service hop', () => {
    // The gateway's proxy sets x-internal-assertion on its outbound request.
    // If services stripped it (or a client could make it vanish), no request
    // could ever authenticate. Forged assertions are defeated by signature
    // verification (the tests above), not by header deletion.
    expect(SPOOFABLE_IDENTITY_HEADERS).not.toContain(INTERNAL_ASSERTION_HEADER);
  });
});
