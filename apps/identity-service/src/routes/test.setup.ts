// ──────────────────────────────────────────────
// Shared test helpers for the identity-service suites.
// ──────────────────────────────────────────────

import { loadDotenv, type IdentityEnv } from '@school-erp/config';
import { testKeypair, testSecret, type TestKeypair } from '@school-erp/testing';

loadDotenv();

/** Password every seeded login user in these suites is created with. */
export const TEST_PASSWORD = 'CorrectHorse9!';

export function makeIdentityTestEnv(
  databaseUrl: string,
  keypair: TestKeypair,
): IdentityEnv {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: databaseUrl,
    CONTROL_PLANE_DATABASE_URL: databaseUrl,
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: testSecret(),
    JWT_REFRESH_SECRET: testSecret(),
    JWT_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '30d',
    INTERNAL_ASSERTION_PUBLIC_KEY: keypair.publicKey,
    PORT_IDENTITY_SERVICE: 4001,
    LOGIN_MAX_ATTEMPTS: 5,
    LOGIN_WINDOW_MINUTES: 15,
    LOGIN_LOCKOUT_THRESHOLD: 10,
    BCRYPT_COST: 10,
    PASSWORD_MIN_LENGTH: 10,
    PASSWORD_BREACH_CHECK: false,
  };
}

export { testKeypair };
