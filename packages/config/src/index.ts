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
  serviceEnvSchema,
  loadGatewayEnv,
  loadIdentityEnv,
  loadServiceEnv,
} from './schemas';

export type { GatewayEnv, IdentityEnv, ServiceEnv } from './schemas';
