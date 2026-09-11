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

// RS256 (RSA-2048). The original design called for EdDSA, but jsonwebtoken —
// the same library that signs the user tokens in tokens.ts — does not support
// it, and introducing a second JWT library for one feature is not worth it.
// RS256 is the plan's stated alternative (ADR-3: "EdDSA/RS256-signed JWT").

/**
 * Identity headers a client must never be able to set.
 *
 * Stripped by every app (gateway and services). NOTE: `x-internal-assertion`
 * is deliberately NOT in this list — services receive it from the gateway's
 * proxy on every hop and must not strip it before verifying. A forged copy is
 * defeated by signature verification, not by header deletion.
 *
 * `x-tenant-slug` is also NOT here: it is a routing hint (which school's login
 * a mobile client is reaching), not an identity. It carries no privilege —
 * credentials are still verified against the routed tenant's own database —
 * and the gateway normalizes it (subdomain first, mobile header second)
 * before forwarding. `x-tenant-id` stays stripped: that one IS an identity.
 */
export const SPOOFABLE_IDENTITY_HEADERS = [
  'x-user-id',
  'x-user-email',
  'x-user-role',
  'x-user-roles',
  'x-branch-id',
  'x-school-id',
  'x-tenant-id',
  'x-permissions',
  'x-impersonated-by',
] as const;

export const INTERNAL_ASSERTION_HEADER = 'x-internal-assertion';

const ISSUER = 'school-erp-gateway';

export const assertionClaimsSchema = z.object({
  /** User ID. */
  sub: z.string().min(1),
  email: z.string().email(),
  /**
   * Tenant (school) the request operates within — the CONTROL-PLANE tenant id,
   * which is what @school-erp/tenant resolves to a database connection.
   *
   * MAY be empty: single-database deployments (local dev, self-hosted starter)
   * have no control plane and identity-service signs `tenantId: ""`. Services
   * must treat empty as "no multi-tenant routing" — never as a tenant key.
   */
  tenantId: z.string().min(0),
  /**
   * The School row id INSIDE the tenant database (the data-level tenant).
   * Distinct from tenantId: one names the platform registry row, the other
   * names the school record the handlers write against.
   */
  schoolId: z.string().min(1).nullable().optional(),
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
  /** Control-plane tenant id — routing key for @school-erp/tenant. */
  tenantId: string;
  /** School row id inside the tenant database — the handlers' write key. */
  schoolId: string | null;
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
  /** School row id inside the tenant database, when known. */
  schoolId?: string | null;
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
 * Signed RS256 (RSA-2048): downstream services hold only the public key, so a
 * compromised leaf service cannot mint credentials for its peers. Signing
 * happens once per proxied request and is fast enough at gateway scale.
 */
export function mintAssertion(input: MintAssertionInput, signer: AssertionSigner): string {
  const payload = {
    sub: input.userId,
    email: input.email,
    tenantId: input.tenantId,
    schoolId: input.schoolId ?? null,
    branchId: input.branchId ?? null,
    roles: input.roles,
    ...(input.permissions ? { permissions: input.permissions } : {}),
    impersonatedBy: input.impersonatedBy ?? null,
  };

  const options: SignOptions = {
    algorithm: 'RS256',
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
      algorithms: ['RS256'], // pinned: never accept `none`, never accept HMAC
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
    schoolId: claims.schoolId ?? null,
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
