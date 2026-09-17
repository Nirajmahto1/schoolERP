// ──────────────────────────────────────────────
// @school-erp/config — fail-fast environment validation
// ──────────────────────────────────────────────

export {
  loadDotenv,
  parseEnv,
  secretString,
  port,
  connectionString,
  csvList,
  jwtDuration,
  nodeEnv,
} from './env';

export {
  gatewayEnvSchema,
  identityEnvSchema,
  provisionEnvSchema,
  serviceEnvSchema,
  loadGatewayEnv,
  loadIdentityEnv,
  loadProvisionEnv,
  loadServiceEnv,
} from './schemas';

export type { GatewayEnv, IdentityEnv, ProvisionEnv, ServiceEnv } from './schemas';
