// ──────────────────────────────────────────────
// @school-erp/testing — shared test harness (BUILD_PLAN 0.7.2)
//
// One place for the pieces every service test needs:
//   • Deterministic RSA-2048 test keypairs + assertion minting
//   • A schema-isolated ephemeral Postgres (migrated + torn down per suite)
//   • Multi-tenant seed fixtures for the cross-tenant isolation suite
// ──────────────────────────────────────────────

export {
  assertionFor,
  signerFor,
  testKeypair,
  testSecret,
  type TestIdentity,
  type TestKeypair,
} from './keys';

export {
  TestDatabase,
  withSchema,
} from './database';

export {
  seedTenant,
  type TenantSeed,
} from './tenants';