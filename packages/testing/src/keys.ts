import { generateKeyPairSync, randomBytes } from 'crypto';
import { mintAssertion, type AssertionSigner } from '@school-erp/auth';

export interface TestKeypair {
  /** PKCS8 PEM, gateway-side. */
  privateKey: string;
  /** SPKI PEM, service-side verifier key. */
  publicKey: string;
}

/** A fresh RSA-2048 keypair for tests — never reuse across suites. */
export function testKeypair(): TestKeypair {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export function signerFor(keypair: TestKeypair, ttlSeconds = 60): AssertionSigner {
  return { privateKey: keypair.privateKey, ttlSeconds };
}

export interface TestIdentity {
  userId: string;
  email: string;
  tenantId: string;
  branchId: string | null;
  roles: string[];
}

/** Mint a valid assertion for one upstream service. */
export function assertionFor(
  keypair: TestKeypair,
  audience: string,
  identity: TestIdentity,
): string {
  return mintAssertion(
    {
      userId: identity.userId,
      email: identity.email,
      tenantId: identity.tenantId,
      branchId: identity.branchId,
      roles: identity.roles,
      audience,
    },
    signerFor(keypair),
  );
}

/** A cryptographically random secret that passes @school-erp/config checks. */
export function testSecret(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}