// ──────────────────────────────────────────────
// @school-erp/tenant — tenant resolution, connection routing, tenant context
// (BUILD_PLAN 1.3)
// ──────────────────────────────────────────────

export {
  TenantRegistry,
  TenantUnavailableError,
  type TenantRecord,
  type TenantRegistryOptions,
} from './registry';

export {
  MemoryTenantCache,
  RedisTenantCache,
  type TenantCache,
  type RedisLike,
} from './cache';

export {
  LruTenantClientCache,
  type TenantClientCache,
} from './client-cache';

export {
  NoTenantContextError,
  currentTenantId,
  runWithTenant,
} from './context';

export {
  withTenant,
  tenantErrorHandler,
  tenantOf,
  tenantPrisma,
  type WithTenantOptions,
} from './middleware';

export { createTenantBoundPrisma } from './bound-client';

export { tenantStatusHttp, type TenantStatusHttp } from './status';

export {
  deindexTenant,
  emailHash,
  findUserTenant,
  indexTenantUser,
  indexTenantUsers,
  newLoginTraceId,
  type DirectoryEntry,
} from './directory';
