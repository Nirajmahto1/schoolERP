// @school-erp/domain — Phase 2 domain engines (BUILD_PLAN 2.2–2.5).
//
// Pure TypeScript over the tenant Prisma client. No HTTP, no framework: these
// are the invariants every service shares, and the GATE-2 verification tests
// exercise them directly against a migrated schema.

export * from './sequences';
export * from './enrollments';
export * from './promotion';
export * from './fees';
export * from './attendance';
export { seedDemoTenant, type DemoSeedOptions, type DemoSeedResult } from './demo-seed';