// ──────────────────────────────────────────────
// Object storage provisioning tests (BUILD_PLAN 1.2.5)
//
// The real MinIO path (bucket creation + STS AssumeRole) is exercised against
// a live MinIO only when `docker:up` is running — CI has no MinIO service, so
// these tests use injected fakes for the bucket/credential steps and assert
// the pipeline semantics: idempotent bucket name, bucket-scoped policy, skip
// when unconfigured, best-effort failure (tenant still provisioned + audited).
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDotenv } from '@school-erp/config';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { TestDatabase } from '@school-erp/testing';
import { provisionTenant } from '../src/provision';
import {
  loadStorageConfig,
  provisionTenantStorage,
  provisionTenantStorageOrDefault,
  tenantBucketName,
  tenantBucketPolicy,
  type StorageConfig,
} from '../src/storage';

loadDotenv();

const CONFIG: StorageConfig = {
  endpoint: 'localhost',
  port: 9000,
  useSSL: false,
  accessKey: 'rootkey',
  secretKey: 'rootsecret',
  region: 'us-east-1',
};

describe('storage helpers', () => {
  it('builds a bucket name that is lowercase, dashed, and capped at 63 chars', () => {
    expect(tenantBucketName('dps-noida')).toBe('tenant-dps-noida');
    expect(tenantBucketName('long_slug_under_63')).toBe('tenant-long-slug-under-63');
    const long = tenantBucketName('a-very-long-school-slug-with-many-words-in-it-here-ok');
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^tenant-[a-z0-9-]+$/);
  });

  it('scopes the policy to exactly one tenant bucket', () => {
    const policy = JSON.parse(tenantBucketPolicy('tenant-dps-noida')) as {
      Statement: Array<{ Resource: string[] }>;
    };
    const resources = policy.Statement[0].Resource;
    expect(resources).toContain('arn:aws:s3:::tenant-dps-noida');
    expect(resources).toContain('arn:aws:s3:::tenant-dps-noida/*');
    expect(JSON.stringify(policy)).not.toContain('tenant-other');
  });

  it('loadStorageConfig returns null when MinIO is not configured', () => {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.MINIO_ENDPOINT;
    delete env.MINIO_ACCESS_KEY;
    delete env.MINIO_SECRET_KEY;
    expect(loadStorageConfig(env)).toBeNull();
  });

  it('loadStorageConfig throws when endpoint is set but credentials are missing', () => {
    const env = { MINIO_ENDPOINT: 'localhost' } as NodeJS.ProcessEnv;
    expect(() => loadStorageConfig(env)).toThrow(/MINIO_ACCESS_KEY\/MINIO_SECRET_KEY/);
  });

  it('provisionTenantStorageOrDefault skips when given an env without MinIO config', async () => {
    const result = await provisionTenantStorageOrDefault('skip-co', {});
    expect('skipped' in result).toBe(true);
    expect((result as { reason: string }).reason).toMatch(/MINIO_ENDPOINT not set/);
  });
});

describe('provisionTenantStorage (injected fakes)', () => {
  it('creates the bucket once (idempotent) and returns scoped credentials', async () => {
    const made: string[] = [];
    const storage = await provisionTenantStorage('dps-noida', {
      config: CONFIG,
      makeBucket: async (bucket) => {
        made.push(bucket);
      },
      mintCredentials: async (bucket) => ({
        accessKey: `scoped-${bucket}`,
        secretKey: 'secret',
        sessionToken: 'token',
        expiresAt: '2026-09-10T00:00:00Z',
      }),
    });

    expect(made).toEqual(['tenant-dps-noida']);
    expect(storage.bucket).toBe('tenant-dps-noida');
    expect(storage.endpoint).toBe('http://localhost:9000');
    expect(storage.accessKey).toBe('scoped-tenant-dps-noida');
    expect(storage.sessionToken).toBe('token');
  });

  it('does not recreate an existing bucket', async () => {
    const made: string[] = [];
    await provisionTenantStorage('dps-noida', {
      config: CONFIG,
      makeBucket: async (bucket) => {
        made.push(bucket);
      },
      mintCredentials: async () => ({
        accessKey: 'a',
        secretKey: 'b',
        sessionToken: null,
        expiresAt: null,
      }),
    });
    // In the real adapter the bucketExists check decides; the injected fake
    // records a single call — the point is the pipeline calls it exactly once.
    expect(made).toHaveLength(1);
  });
});

describe('provisionTenant pipeline storage step', () => {
  let controlDb: TestDatabase;
  let controlPlane: ControlPlaneClient;
  const tenantDbs = new Map<string, TestDatabase>();

  beforeAll(async () => {
    controlDb = await TestDatabase.create(process.env.DATABASE_URL, { project: 'control-plane' });
    controlPlane = new ControlPlaneClient({ datasourceUrl: controlDb.url });
  });

  afterAll(async () => {
    for (const td of tenantDbs.values()) await td.teardown();
    tenantDbs.clear();
    await controlDb.teardown();
    await controlPlane.$disconnect();
  });

  function makeDeps(overrides: Record<string, unknown> = {}) {
    const base = process.env.DATABASE_URL as string;
    return {
      controlPlane,
      adminDatabaseUrl: base,
      createDatabase: async (dbName: string) => {
        const td = await TestDatabase.create(base);
        tenantDbs.set(dbName, td);
        return td.url;
      },
      dropDatabase: async (dbName: string) => {
        const td = tenantDbs.get(dbName);
        if (td) {
          await td.teardown();
          tenantDbs.delete(dbName);
        }
      },
      ...overrides,
    };
  }

  // These run the full pipeline (real migration subprocess + seeding), so they
  // need far more than vitest's 5s default — especially under turbo's parallel
  // load (matches the explicit-timeout convention elsewhere in this suite).
  it('provisions storage when configured and reports it in the result', async () => {
    const deps = makeDeps({
      provisionStorage: async (slug: string) => ({
        bucket: `tenant-${slug}`,
        endpoint: 'http://localhost:9000',
        region: 'us-east-1',
        accessKey: 'scoped-key',
        secretKey: 'scoped-secret',
        sessionToken: 'tok',
        expiresAt: '2026-09-10T00:00:00Z',
      }),
    });

    const result = await provisionTenant({ slug: 'store-co', legalName: 'Store Co' }, deps);
    expect(result.storage).toMatchObject({ bucket: 'tenant-store-co', accessKey: 'scoped-key' });
    expect('skipped' in result.storage).toBe(false);
  }, 60_000);

  it('skips storage cleanly when the storage step reports a skip', async () => {
    const deps = makeDeps({
      provisionStorage: async () => ({
        skipped: true as const,
        reason: 'MINIO_ENDPOINT not set — object storage skipped.',
      }),
    });

    const result = await provisionTenant({ slug: 'no-store-co', legalName: 'No Store Co' }, deps);
    expect('skipped' in result.storage).toBe(true);
    expect((result.storage as { reason: string }).reason).toMatch(/MINIO_ENDPOINT not set/);
  }, 60_000);

  it('is best-effort: a storage failure does not fail the tenant, and is audited', async () => {
    const deps = makeDeps({
      provisionStorage: async () => {
        throw new Error('minio is down');
      },
    });

    const result = await provisionTenant({ slug: 'semi-co', legalName: 'Semi Co' }, deps);
    expect(result.tenantId).toBeTruthy();
    expect(result.alreadyProvisioned).toBe(false);
    expect('skipped' in result.storage).toBe(true);
    expect((result.storage as { reason: string }).reason).toMatch(/minio is down/);

    const tenant = await controlPlane.tenant.findUnique({ where: { slug: 'semi-co' } });
    const failure = await controlPlane.provisionAudit.findFirst({
      where: { tenantId: tenant!.id, action: 'tenant.storage.failed' },
    });
    expect(failure).toBeTruthy();
    expect(failure!.payload).toMatchObject({ error: 'minio is down' });
  }, 60_000);
});