// ──────────────────────────────────────────────
// Shared test helpers for the student-service suites.
//
// Tests build the app with an injected Prisma client and an explicitly
// constructed environment — no port binding, no reliance on the real .env.
// ──────────────────────────────────────────────

import { loadDotenv, type ServiceEnv } from '@school-erp/config';
import { testKeypair, testSecret, type TestKeypair } from '@school-erp/testing';

// The monorepo-root .env provides DATABASE_URL for the ephemeral test schema.
// Idempotent; in CI the variable comes from the workflow env instead.
loadDotenv();

/** Password every seeded login user in these suites is created with. */
export const TEST_PASSWORD = 'CorrectHorse9!';

export function makeIdentityTestEnv(
  databaseUrl: string,
  keypair: TestKeypair,
): ServiceEnv {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: databaseUrl,
    CONTROL_PLANE_DATABASE_URL: databaseUrl,
    PORT: 4001,
    INTERNAL_ASSERTION_PUBLIC_KEY: keypair.publicKey,
    // Messaging quiet hours (§5.8) — defaults the schema would supply when
    // parsing real env; explicit here because this object IS the env.
    QUIET_HOURS_START: 21,
    QUIET_HOURS_END: 8,
    // Peer-call base URL (absence-alert fire); never exercised by these suites.
    COMMUNICATION_SERVICE_URL: 'http://localhost:4005',
    // Timetable engine peer (Phase 6.4 adapter pattern); never exercised here.
    // The schema default would fill this at parse-time, but this object is
    // typed as the parsed OUTPUT env, so the field must be explicit.
    TIMETABLE_ENGINE_URL: 'http://localhost:6003',
    // Notification engine peer (live WS frames); never exercised here.
    NOTIFICATION_ENGINE_URL: 'http://localhost:6001',
    // Chat hub listen port (Phase 9); never exercised here.
    CHAT_HUB_PORT: 6005,
  };
}

export { testKeypair };