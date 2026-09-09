// ──────────────────────────────────────────────
// @school-erp/provisioning-service — platform operations
// (BUILD_PLAN 1.2 provisioning, 1.4 migrations, 1.5 lifecycle)
// ──────────────────────────────────────────────

export {
  provisionTenant,
  createDatabase,
  dropDatabase,
  databaseExists,
  type CreateTenantInput,
  type CreateTenantResult,
  type ProvisionDeps,
} from './provision';

export {
  backupTenant,
  rehearseRestore,
  type BackupResult,
  type RestoreDrillResult,
} from './backup';

export {
  createTenantRole,
  dropTenantRole,
  safeRoleName,
  tenantRoleConnRef,
  type TenantRole,
} from './roles';

export {
  migrateAll,
  runTenantMigration,
  tenantFleetStatus,
  latestSchemaVersion,
  type FleetRow,
  type MigrateAllOptions,
  type MigrateAllResult,
} from './migrate';

export {
  changePlan,
  exportTenant,
  hardDeleteTenant,
  recountSeats,
  resumeTenant,
  scheduleTenantDeletion,
  suspendTenant,
  type TenantExport,
} from './lifecycle';

export {
  seedIndiaDefaults,
  CLASS_LADDER,
  currentAcademicYearName,
  type SeedDefaultsInput,
  type SeedDefaultsResult,
} from './defaults';

export {
  RESERVED_SLUGS,
  normalizeSlug,
  slugProblem,
} from './slugs';

export {
  loadProvisioningEnv,
  tenantConnectionRef,
  tenantDatabaseName,
  toMaintenanceUrl,
  type ProvisioningEnv,
} from './config';

export {
  loadStorageConfig,
  provisionTenantStorage,
  provisionTenantStorageOrDefault,
  tenantBucketName,
  tenantBucketPolicy,
  type ScopedCredentials,
  type StorageConfig,
  type StorageDeps,
  type StorageSkipped,
  type TenantStorage,
} from './storage';

export { audit } from './audit';