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
  loadDotenv,
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

// ── Razorpay fee collection (BUILD_PLAN 4.1) ──
// Optional: a service boots without keys (checkout endpoints answer 503
// 'not configured'), because CI and local dev have no Razorpay account. The
// webhook secret alone is enough to run reconciliation against a store that
// already has gateway rows.
const razorpaySchema = z.object({
  // An empty value in .env (e.g. `RAZORPAY_KEY_ID=`) means "not configured",
  // not "invalid" — trimmed empties normalize to undefined.
  RAZORPAY_KEY_ID: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional()),
  RAZORPAY_KEY_SECRET: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional()),
  RAZORPAY_WEBHOOK_SECRET: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional()),
});

// ── Messaging providers (BUILD_PLAN 5.1 / 5.2) ──
// All optional: a school boots (and the dispatcher queues rows) without any
// provider configured — sends then fail CLOSED into NotificationLog FAILED
// rows with a clear error, never a crash. WhatsApp uses the Meta Cloud API
// directly (no BSP middleman needed to start); SMS rides a DLT-registered
// REST gateway whose shape every Indian aggregator (MSG91, Kaleyra, Textlocal)
// shares closely enough for the adapter.
const messagingSchema = z.object({
  // Meta WhatsApp Cloud API — the phone-number-id scopes templates + sends.
  WHATSAPP_TOKEN: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional()),
  WHATSAPP_PHONE_NUMBER_ID: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional()),
  // Meta signs webhook callbacks with this secret over the raw body.
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional()),
  // DLT SMS gateway: TRAI-registered sender header (e.g. `DPSNOT`) + DLT
  // template IDs ride per-send; the base URL + key are the aggregator's.
  SMS_API_BASE: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().url().optional()),
  SMS_API_KEY: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional()),
  SMS_SENDER_HEADER: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).max(6).optional()),
  // Generic webhook secret for provider delivery callbacks (shared HMAC).
  MESSAGING_WEBHOOK_SECRET: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional()),
  // Email (§5.3) — exactly one provider is configured at a time; both set is
  // a misconfiguration the service refuses (silent double-sending risk).
  // SES: SMTP-interface credentials used against the HTTPS v2 SendEmail
  // endpoint via SigV4 — region + access key + secret key.
  AWS_SES_REGION: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional()),
  AWS_SES_ACCESS_KEY_ID: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional()),
  AWS_SES_SECRET_ACCESS_KEY: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional()),
  // Postmark: one server token, simplest email API that exists.
  POSTMARK_SERVER_TOKEN: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional()),
  // Verified From address (either provider refuses unverified senders).
  EMAIL_FROM_ADDRESS: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().email().optional()),
  EMAIL_FROM_NAME: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional()),
  // FCM push (§5.4): a Google service account with the
  // `https://www.googleapis.com/auth/firebase.messaging` scope. All three
  // vars are needed together; any missing → push channel unconfigured and
  // the dispatcher fails sends closed like the other channels.
  FCM_PROJECT_ID: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().min(1).optional()),
  FCM_CLIENT_EMAIL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().email().optional()),
  // The service-account PEM with literal \n escapes (as pasted from the JSON
  // key file) — normalized to real newlines here so the crypto layer just works.
  FCM_PRIVATE_KEY: z.preprocess(
    (v) => (typeof v !== 'string' || v.trim() === '' ? undefined : v.replace(/\\n/g, '\n')),
    z.string().min(1).optional(),
  ),
  // Quiet hours (IST, server-local hour numbers) — §5.8: no promotional or
  // non-urgent sends inside the window; transactional/urgent bypasses.
  QUIET_HOURS_START: z.coerce.number().int().min(0).max(23).default(21),
  QUIET_HOURS_END: z.coerce.number().int().min(0).max(23).default(8),
});

// ── Gateway ──

export const gatewayEnvSchema = baseSchema.merge(jwtSchema)
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
    PORT_PROVISION_SERVICE: port(4009),
    PORT_STUDENT_SERVICE: port(4001),
    PORT_STAFF_SERVICE: port(4002),
    PORT_ACADEMIC_SERVICE: port(4003),
    PORT_FEE_SERVICE: port(4004),
    PORT_COMMUNICATION_SERVICE: port(4005),
    PORT_ATTENDANCE_SERVICE: port(4006),
    PORT_EXAM_SERVICE: port(4007),
    PORT_ANALYTICS_SERVICE: port(5001),
    PORT_AI_SERVICE: port(5002),
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

// ── provision-service (first-run bootstrap + branch management) ──
//
// Self-hosted deployments get a first-run page instead of a CLI: the operator
// names the school, creates the owner account, and lands in the dashboard.
// One database per VPS deployment is the supported shape.

export const provisionEnvSchema = baseSchema
  .merge(databaseSchema)
  .merge(controlPlaneSchema)
  .merge(assertionVerifierSchema)
  .extend({
    PORT_PROVISION_SERVICE: port(4009),

    /** Single-database deployments run without a control plane. */
    CONTROL_PLANE_DATABASE_URL: z
      .union([connectionString(['postgresql', 'postgres']), z.literal('')])
      .optional()
      .transform((v) => (v ? v : undefined)),

    /**
     * Optional shared secret for POST /setup on shared infrastructure: when
     * set, the wizard page must send it as `x-setup-token`. Unset (the
     * default) means the empty-database guard is the only gate — correct for
     * a single-school VPS where the wizard is reachable only until first run.
     */
    SETUP_TOKEN: z.string().min(16).optional(),
  });

export type ProvisionEnv = z.infer<typeof provisionEnvSchema>;
export const loadProvisionEnv = () => parseEnv(provisionEnvSchema, 'provision-service');

// ── Generic downstream service (staff, academic, fee, attendance, comms) ──
// Where a service calls a PEER service directly (not through the gateway),
// it needs the peer's base URL. Optional with a localhost default so single-
// machine dev just works, and so CI suites that never call peers don't need
// the variable. Direct peer calls mint their own short-lived assertions —
// which requires the PRIVATE key; a service without it (leaf services hold
// only the public key per ADR-3) simply skips the peer call, which is why
// every peer call must be an enhancement, never a correctness dependency.
const peerServicesSchema = z.object({
  COMMUNICATION_SERVICE_URL: z.string().url().default('http://localhost:4005'),
  // Chat WebSocket hub (Phase 9): communication-service attaches a `ws`
  // server to its HTTP listener for live class-room chat delivery. The
  // ticket secret signs short-lived connect tickets minted by the
  // assertion-verified /chat/ticket route. OPTIONAL: unset means live
  // delivery is disabled and /chat/ticket answers 503 — polling still
  // works. Generate with `openssl rand -hex 32`.
  CHAT_TICKET_SECRET: z.preprocess(
    (v) => (typeof v !== 'string' || v.trim() === '' ? undefined : v),
    z.string().min(32).optional(),
  ),
  // Dedicated listener for the chat hub. The hub ALSO listens on the main
  // HTTP port (behind the gateway's ws proxy); this second port exists for
  // direct containers/mobile builds that bypass the gateway.
  CHAT_HUB_PORT: port(4015),
  // Optional Redis pub/sub: with it, several communication-service replicas
  // deliver chat to every connected socket; without it, delivery is
  // in-process only (single-node dev). Presence/rooms always resolve live
  // from the DB, so a dropped Redis only means missed live pushes, never
  // stale history.
  REDIS_URL: z.preprocess(
    (v) => (typeof v !== 'string' || v.trim() === '' ? undefined : v),
    connectionString(['redis', 'rediss']).optional(),
  ),
  // Timetable engine (Phase 6.2): the constraint solver academic-service calls
  // to generate/persist timetables and suggest substitutions.
  TIMETABLE_ENGINE_URL: z.string().url().default('http://localhost:6003'),
  // Notification engine (Phase 6.1): services push live WebSocket
  // notifications here (POST /notifications/send, channel=user|branch|...).
  // Like COMMUNICATION_SERVICE_URL: optional with a localhost default so
  // single-machine dev just works and CI never needs the variable.
  NOTIFICATION_ENGINE_URL: z.string().url().default('http://localhost:6001'),
  // Private signing material for direct peer calls (a service minting its
  // own assertion for a peer). Optional — leaf services hold only the
  // public key per ADR-3, and a service without it skips peer enhancements
  // (e.g. the live absence-alert fire; the morning sweep still covers it).
  INTERNAL_ASSERTION_PRIVATE_KEY: z.preprocess(
    (v) => (typeof v !== 'string' || v.trim() === '' ? undefined : v),
    z.string().min(1).optional(),
  ),
  // ── Nightly late-fee sweep (fee-service) ──
  // Applies the branch's late-fee slabs to overdue invoices once a day.
  // Idempotent by ledger reference (LATE:<rule>:<invoice>), so the sweep and
  // a manual "Apply" from the console can never double-fine the same
  // invoice. LATE_FEE_SWEEP_HOUR is SERVER-LOCAL (IST on the deployment
  // box); 01:00 keeps it clear of the morning communication sweeps and the
  // midnight Razorpay settlement boundary. Set LATE_FEE_SWEEP_ENABLED=false
  // to stop fining automatically (e.g. a school that wants manual control).
  LATE_FEE_SWEEP_ENABLED: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toLowerCase() !== 'false' : true),
    z.boolean().default(true),
  ),
  LATE_FEE_SWEEP_HOUR: z.coerce.number().int().min(0).max(23).default(1),
  // Run window length in hours: the hourly tick fires when hour === SWEEP_HOUR,
  // but a service down at that hour would skip the day — so the sweep also
  // runs when the hour falls INSIDE the first WINDOW hours after boot... no:
  // the window is a catch-up band; see scheduler for the exact predicate.
  // Catch-up band: if the service boots (or wakes) within WINDOW hours after
  // SWEEP_HOUR and the sweep has not run today, it runs late rather than
  // skipping the day. Max 12 keeps "nightly" nightly.
  LATE_FEE_SWEEP_WINDOW_HOURS: z.coerce.number().int().min(1).max(12).default(2),
});

export const serviceEnvSchema = baseSchema
  .merge(databaseSchema)
  .merge(assertionVerifierSchema)
  .merge(controlPlaneSchema)
  .merge(razorpaySchema)
  .merge(messagingSchema)
  .merge(peerServicesSchema)
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
  // Load .env BEFORE snapshotting process.env: parseEnv also calls loadDotenv,
  // but by then `source` (a snapshot taken below) would already have been built
  // without the file's values — so every var added to .env after the other
  // services' vars silently fell back to schema defaults (exam-service booted
  // on port 4000 and collided with the gateway).
  loadDotenv();
  const source: NodeJS.ProcessEnv = { ...process.env };
  if (source[portVar] !== undefined) source.PORT = source[portVar];
  return parseEnv(serviceEnvSchema, serviceName, source);
}
