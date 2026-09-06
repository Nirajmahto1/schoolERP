// ──────────────────────────────────────────────
// @school-erp/auth
//
// One place for every authentication and authorization decision in the fleet.
// With 12 services, a security fix applied 12 times by hand is a security fix
// applied 8 times.
// ──────────────────────────────────────────────

export {
  INTERNAL_ASSERTION_HEADER,
  SPOOFABLE_IDENTITY_HEADERS,
  AssertionError,
  assertionClaimsSchema,
  mintAssertion,
  verifyAssertion,
} from './assertion';
export type {
  AssertionClaims,
  AssertionSigner,
  MintAssertionInput,
  RequestContext,
} from './assertion';

export {
  assertSameTenant,
  ctx,
  requireAssertion,
  requirePermission,
  requireRole,
  stripSpoofableHeaders,
} from './middleware';

export {
  TokenError,
  issueTokenPair,
  revokeAllSessions,
  revokeSession,
  rotateRefreshToken,
  verifyAccessToken,
} from './tokens';
export type {
  AccessTokenClaims,
  LiveUser,
  TokenConfig,
  TokenPair,
  TokenStore,
} from './tokens';

export { MemoryTokenStore } from './memory-store';

export { createServiceApp, listenWithGracefulShutdown } from './bootstrap';
export type { ServiceApp, ServiceAppOptions } from './bootstrap';

export { RedisTokenStore } from './redis-store';

export {
  PasswordPolicyError,
  assertPasswordAcceptable,
  isPasswordBreached,
} from './password';
