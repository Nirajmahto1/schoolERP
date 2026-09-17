// ──────────────────────────────────────────────
// Shared test helpers for the provision-service suites.
// ──────────────────────────────────────────────

import { loadDotenv, type ProvisionEnv } from '@school-erp/config';
import { testKeypair, testSecret, type TestKeypair } from '@school-erp/testing';

loadDotenv();

export function makeProvisionTestEnv(
  databaseUrl: string,
  keypair: TestKeypair,
): ProvisionEnv {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: databaseUrl,
    CONTROL_PLANE_DATABASE_URL: undefined,
    PORT_PROVISION_SERVICE: 4009,
    INTERNAL_ASSERTION_PUBLIC_KEY: keypair.publicKey,
    SETUP_TOKEN: undefined,
  } as ProvisionEnv;
}
