// ──────────────────────────────────────────────
// Per-service environment schemas
//
// Each service imports exactly the config it needs. A service that does not
// need JWT_SECRET must not be able to boot with a bad one — and must not be
// able to read one it has no business reading.
// ──────────────────────────────────────────────

import { z } from 'zod';
import {
  connectionString,
  csvList,
  jwtDuration,
  nodeEnv,
  parseEnv,
  port,
  secretString,
} from './env';

// ── Building blocks shared by every backend service ──

const baseSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
});

const databaseSchema = z.object({
  DATABASE_URL: connectionString(['postgresql', 'postgres']),
});

const redisSchema = z.object({
  REDIS_URL: connectionString(['redis', 'rediss']),
});

/**
 * Token verification material.
 *
 * Access tokens are short-lived (15m default, down from the previous 7d) because
 * revocation is enforced by a Redis denylist keyed on `jti`, and a long TTL
 * means a long denylist. Refresh tokens rotate on every use.
 */
const jwtSchema = z.object({
  JWT_SECRET: secretString(32),
  JWT_EXPIRES_IN: jwtDuration.default('15m'),
  JWT_REFRESH_SECRET: secretString(32),
  JWT_REFRESH_EXPIRES_IN: jwtDuration.default('30d'),
});

/**
 * Service-to-service assertion material (ADR-3).
 *
 * The gateway holds the private key and mints 60-second assertions; every
 * downstream service holds only the public key and verifies. Splitting these
 * means a compromised leaf service cannot mint credentials for its peers.
 */
const assertionSignerSchema = z.object({
  INTERNAL_ASSERTION_PRIVATE_KEY: secretString(64),
  INTERNAL_ASSERTION_PUBLIC_KEY: secretString(64),
  INTERNAL_ASSERTION_TTL_SECONDS: z.coerce.number().int().min(10).max(300).default(60),
});

const assertionVerifierSchema = z.object({
  INTERNAL_ASSERTION_PUBLIC_KEY: secretString(64),
});

// ── Gateway ──

export const gatewayEnvSchema = baseSchema
  .merge(jwtSchema)
  .merge(redisSchema)
  .merge(assertionSignerSchema)
  .extend({
    PORT_GATEWAY: port(4000),

    /**
     * Explicit CORS allowlist. Replaces `cors({ origin: true })`, which
     * reflected any requesting origin while also sending credentials.
     */
    CORS_ALLOWED_ORIGINS: csvList,

    PORT_IDENTITY_SERVICE: port(4010),
    PORT_STUDENT_SERVICE: port(4001),
    PORT_STAFF_SERVICE: port(4002),
    PORT_ACADEMIC_SERVICE: port(4003),
    PORT_FEE_SERVICE: port(4004),
    PORT_COMMUNICATION_SERVICE: port(4005),
    PORT_ATTENDANCE_SERVICE: port(4006),
    PORT_EXAM_SERVICE: port(4007),
    PORT_ANALYTICS_SERVICE: port(5001),
    PORT_AI_SERVICE: port(5002),
    PORT_GO_SERVICE: port(5003),
    PORT_NOTIFICATION_ENGINE: port(6001),
    PORT_BULK_PROCESSOR: port(6002),
    PORT_TIMETABLE_ENGINE: port(6003),
    PORT_FILE_SERVICE: port(6004),

    UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
    UPSTREAM_HOST: z.string().default('localhost'),

    /**
     * Apex domain tenants get subdomains of (`dps-noida.yourapp.in` → slug
     * `dps-noida`, BUILD_PLAN 1.3.1). Optional: when unset the gateway only
     * forwards the mobile app's explicit `X-Tenant-Slug` hint.
     */
    TENANT_BASE_DOMAIN: z.string().min(1).optional(),
  });

export type GatewayEnv = z.infer<typeof gatewayEnvSchema>;
export const loadGatewayEnv = () => parseEnv(gatewayEnvSchema, 'api-gateway');

/**
 * The platform registry database (Phase 1). Every tenant-aware service needs
 * it to resolve school → database, even though it never reads school data
 * from it.
 */
const controlPlaneSchema = z.object({
  CONTROL_PLANE_DATABASE_URL: connectionString(['postgresql', 'postgres']),
});

// ── identity (Phase 3.1: extracted from student-service into its own service) ──

export const identityEnvSchema = baseSchema
  .merge(databaseSchema)
  .merge(redisSchema)
  .merge(jwtSchema)
  .merge(assertionVerifierSchema)
  .merge(controlPlaneSchema)
  .extend({
    PORT_IDENTITY_SERVICE: port(4010),

    /** Login throttling — per IP and per account. */
    LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
    LOGIN_WINDOW_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
    LOGIN_LOCKOUT_THRESHOLD: z.coerce.number().int().min(5).max(50).default(10),

    BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(12),
    PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(128).default(10),

    /** Check candidate passwords against the HIBP k-anonymity range API. */
    PASSWORD_BREACH_CHECK: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  });

export type IdentityEnv = z.infer<typeof identityEnvSchema>;
export const loadIdentityEnv = () => parseEnv(identityEnvSchema, 'identity-service');

// ── Generic downstream service (staff, academic, fee, attendance, comms) ──

export const serviceEnvSchema = baseSchema
  .merge(databaseSchema)
  .merge(assertionVerifierSchema)
  .merge(controlPlaneSchema)
  .extend({
    PORT: port(4000),
  });

export type ServiceEnv = z.infer<typeof serviceEnvSchema>;

/**
 * Downstream services differ only in which PORT_* variable names their port,
 * so we map it onto a common `PORT` key rather than duplicating a schema
 * per service.
 */
export function loadServiceEnv(serviceName: string, portVar: string): ServiceEnv {
  const source: NodeJS.ProcessEnv = { ...process.env };
  if (source[portVar] !== undefined) source.PORT = source[portVar];
  return parseEnv(serviceEnvSchema, serviceName, source);
}
