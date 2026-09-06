// ──────────────────────────────────────────────
// Internal service-to-service assertions (ADR-3)
//
// THE PROBLEM THIS SOLVES
// Previously the gateway decoded the user's JWT and copied the claims into
// plain HTTP headers (`x-user-id`, `x-user-role`, `x-branch-id`, `x-school-id`),
// and every downstream service read those headers as ground truth. Nothing was
// signed, so anyone able to open a TCP connection to a service port could send
//     x-user-role: SUPER_ADMIN
//     x-school-id: <any school>
// and act as an administrator of any tenant. In a Docker or Kubernetes network
// every sibling container can reach those ports.
//
// THE FIX
// The gateway mints a short-lived (60s) asymmetrically-signed assertion. Every
// service verifies the signature with the PUBLIC key before trusting a single
// claim. Downstream services hold only the public key, so a compromised leaf
// service cannot mint credentials for its peers.
//
// There is deliberately NO header fallback path. A request without a valid
// assertion is rejected.
// ──────────────────────────────────────────────

import jwt, { SignOptions } from 'jsonwebtoken';
import { z } from 'zod';

/** Identity headers a client must never be able to set. Stripped at the edge. */
export const SPOOFABLE_IDENTITY_HEADERS = [
  'x-user-id',
  'x-user-email',
  'x-user-role',
  'x-user-roles',
  'x-branch-id',
  'x-school-id',
  'x-tenant-id',
  'x-tenant-slug',
  'x-permissions',
  'x-internal-assertion',
  'x-impersonated-by',
] as const;

export const INTERNAL_ASSERTION_HEADER = 'x-internal-assertion';

const ISSUER = 'school-erp-gateway';

export const assertionClaimsSchema = z.object({
  /** User ID. */
  sub: z.string().min(1),
  email: z.string().email(),
  /** Tenant (school) the request operates within. */
  tenantId: z.string().min(1),
  /** Branch scope for this request, when the user acts in a single branch. */
  branchId: z.string().min(1).nullable().optional(),
  /** All roles held by the user, not a single role string. */
  roles: z.array(z.string().min(1)).min(1),
  /** Resolved `module.action` permissions, when the gateway has them. */
  permissions: z.array(z.string()).optional(),
  /** Platform admin acting as this user, for audited support access. */
  impersonatedBy: z.string().min(1).nullable().optional(),
  /** Unique assertion ID — lets a service dedupe and lets us trace a request. */
  jti: z.string().min(1),
  /** Intended recipient service. A fee-service assertion is invalid at staff-service. */
  aud: z.string().min(1),
  iss: z.literal(ISSUER),
  iat: z.number(),
  exp: z.number(),
});

export type AssertionClaims = z.infer<typeof assertionClaimsSchema>;

/** The verified request context. Read this instead of any header. */
export interface RequestContext {
  userId: string;
  email: string;
  tenantId: string;
  branchId: string | null;
  roles: string[];
  permissions: string[];
  impersonatedBy: string | null;
  assertionId: string;
}

export interface MintAssertionInput {
  userId: string;
  email: string;
  tenantId: string;
  branchId?: string | null;
  roles: string[];
  permissions?: string[];
  impersonatedBy?: string | null;
  /** Target service name, e.g. `fee-service`. */
  audience: string;
}

export interface AssertionSigner {
  privateKey: string;
  ttlSeconds: number;
}

/**
 * Mint an assertion for one downstream call. Gateway-only.
 *
 * We use EdDSA (Ed25519) rather than RS256: keys and signatures are far
 * smaller, signing is fast enough to do on every proxied request, and there is
 * no key-size footgun.
 */
export function mintAssertion(input: MintAssertionInput, signer: AssertionSigner): string {
  const payload = {
    sub: input.userId,
    email: input.email,
    tenantId: input.tenantId,
    branchId: input.branchId ?? null,
    roles: input.roles,
    ...(input.permissions ? { permissions: input.permissions } : {}),
    impersonatedBy: input.impersonatedBy ?? null,
  };

  const options: SignOptions = {
    algorithm: 'EdDSA',
    issuer: ISSUER,
    audience: input.audience,
    expiresIn: signer.ttlSeconds,
    jwtid: randomId(),
  };

  return jwt.sign(payload, signer.privateKey, options);
}

export class AssertionError extends Error {
  constructor(
    message: string,
    readonly reason: 'missing' | 'invalid' | 'expired' | 'wrong-audience' | 'malformed',
  ) {
    super(message);
    this.name = 'AssertionError';
  }
}

/**
 * Verify an assertion and return the trusted context.
 *
 * `audience` must be the verifying service's own name — this is what stops an
 * assertion minted for one service being replayed against another.
 */
export function verifyAssertion(
  token: string | undefined,
  publicKey: string,
  audience: string,
): RequestContext {
  if (!token) {
    throw new AssertionError('No internal assertion present on request.', 'missing');
  }

  let decoded: unknown;
  try {
    decoded = jwt.verify(token, publicKey, {
      algorithms: ['EdDSA'], // pinned: never accept `none`, never accept HMAC
      issuer: ISSUER,
      audience,
      clockTolerance: 5,
    });
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'TokenExpiredError') {
      throw new AssertionError('Internal assertion has expired.', 'expired');
    }
    if (
      name === 'JsonWebTokenError' &&
      /audience/i.test((err as Error).message)
    ) {
      throw new AssertionError(
        'Internal assertion was minted for a different service.',
        'wrong-audience',
      );
    }
    throw new AssertionError('Internal assertion signature is invalid.', 'invalid');
  }

  const parsed = assertionClaimsSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new AssertionError(
      `Internal assertion claims are malformed: ${parsed.error.issues
        .map((i) => i.path.join('.'))
        .join(', ')}`,
      'malformed',
    );
  }

  const claims = parsed.data;
  return {
    userId: claims.sub,
    email: claims.email,
    tenantId: claims.tenantId,
    branchId: claims.branchId ?? null,
    roles: claims.roles,
    permissions: claims.permissions ?? [],
    impersonatedBy: claims.impersonatedBy ?? null,
    assertionId: claims.jti,
  };
}

function randomId(): string {
  // `crypto` is required lazily so this module stays usable in edge-ish runtimes.
  return require('crypto').randomUUID();
}
