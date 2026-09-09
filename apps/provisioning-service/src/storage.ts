// ──────────────────────────────────────────────
// Tenant object storage (BUILD_PLAN 1.2.5)
//
//   "Create MinIO/S3 bucket prefix + scoped credentials."
//
// One bucket per tenant (`tenant-<slug>`), plus TEMPORARY credentials scoped
// to exactly that bucket via MinIO's STS AssumeRole with an inline policy.
// The minted credentials carry a session token and expire, so a leaked
// credential is short-lived and cannot touch any other tenant's bucket.
//
// MinIO is optional at provision time: when no MINIO_* configuration is
// present the step is skipped (documented in the result + audit) so a school
// can still be provisioned without object storage. Nothing in the platform
// consumes S3 until the Phase 2/3 Document model, at which point the storage
// record should be persisted into a tenant_datastore row (kind S3_PREFIX).
// ──────────────────────────────────────────────

import { Client as MinioClient } from 'minio';
// The STS provider lives at an internal path (not on the main export) in
// minio 8.x. It does the SigV4 signing + XML parsing for us. The package's
// exports map only exposes the CJS condition for this subpath, so it is
// loaded with require() (this package compiles to CommonJS).
interface AssumeRoleProviderCtor {
  new (opts: {
    stsEndpoint: string;
    accessKey: string;
    secretKey: string;
    policy?: string;
    durationSeconds?: number;
    roleSessionName?: string;
  }): {
    getCredentials(): Promise<{
      getAccessKey(): string;
      getSecretKey(): string;
      getSessionToken(): string;
    }>;
  };
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AssumeRoleProvider } = require('minio/dist/main/AssumeRoleProvider.js') as {
  AssumeRoleProvider: AssumeRoleProviderCtor;
};

export interface StorageConfig {
  /** Host only, no scheme — e.g. `localhost`. */
  endpoint: string;
  port: number;
  useSSL: boolean;
  /** Root/admin credentials that can mint scoped credentials. */
  accessKey: string;
  secretKey: string;
  region: string;
}

export interface ScopedCredentials {
  accessKey: string;
  secretKey: string;
  sessionToken: string | null;
  expiresAt: string | null;
}

export interface TenantStorage extends ScopedCredentials {
  bucket: string;
  /** Full endpoint for S3 clients — e.g. `http://localhost:9000`. */
  endpoint: string;
  region: string;
}

/** Read MinIO config from the environment; null means "not configured → skip". */
export function loadStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig | null {
  const endpoint = env.MINIO_ENDPOINT;
  if (!endpoint) return null;
  const accessKey = env.MINIO_ACCESS_KEY;
  const secretKey = env.MINIO_SECRET_KEY;
  if (!accessKey || !secretKey) {
    throw new Error(
      'MINIO_ENDPOINT is set but MINIO_ACCESS_KEY/MINIO_SECRET_KEY are missing — ' +
        'storage provisioning cannot mint scoped credentials.',
    );
  }
  return {
    endpoint,
    port: Number(env.MINIO_PORT ?? 9000),
    useSSL: env.MINIO_USE_SSL === 'true',
    accessKey,
    secretKey,
    region: env.MINIO_REGION ?? 'us-east-1',
  };
}

/** S3 bucket names: lowercase, no underscores, 3–63 chars. */
export function tenantBucketName(slug: string): string {
  return `tenant-${slug.replace(/_/g, '-')}`.slice(0, 63);
}

/** The inline policy that limits minted credentials to ONE tenant's bucket. */
export function tenantBucketPolicy(bucket: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          's3:GetObject',
          's3:PutObject',
          's3:DeleteObject',
          's3:ListBucket',
          's3:GetBucketLocation',
        ],
        Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
      },
    ],
  });
}

export interface StorageDeps {
  config: StorageConfig;
  /** Injectable for tests; defaults to the real MinIO client. */
  makeBucket?: (bucket: string) => Promise<void>;
  /** Injectable for tests; defaults to STS AssumeRole against MinIO. */
  mintCredentials?: (bucket: string) => Promise<ScopedCredentials>;
}

function defaultMakeBucket(config: StorageConfig) {
  const client = new MinioClient({
    endPoint: config.endpoint,
    port: config.port,
    useSSL: config.useSSL,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    region: config.region,
  });
  return async (bucket: string): Promise<void> => {
    const exists = await client.bucketExists(bucket);
    if (!exists) {
      await client.makeBucket(bucket, config.region);
    }
  };
}

function defaultMintCredentials(config: StorageConfig) {
  return async (bucket: string): Promise<ScopedCredentials> => {
    // 12 hours; the STS minimum is 15 minutes. Production callers needing
    // long-lived keys should mint a per-tenant MinIO user instead.
    const provider = new AssumeRoleProvider({
      stsEndpoint: `${config.useSSL ? 'https' : 'http'}://${config.endpoint}:${config.port}`,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      policy: tenantBucketPolicy(bucket),
      durationSeconds: 43_200,
      roleSessionName: bucket,
    });
    const creds = await provider.getCredentials();
    // The provider records the STS Expiration from the response on an
    // internal field; read it defensively since the public d.ts marks it
    // private even though the runtime exposes it.
    const expiresAt = (provider as unknown as { accessExpiresAt?: string }).accessExpiresAt;
    return {
      accessKey: creds.getAccessKey(),
      secretKey: creds.getSecretKey(),
      sessionToken: creds.getSessionToken() || null,
      expiresAt: expiresAt || null,
    };
  };
}

/**
 * Provision one tenant's object storage: bucket + scoped credentials.
 * Idempotent (bucketExists check) — re-provisioning an existing tenant is a
 * no-op for the bucket and mints fresh credentials.
 */
export async function provisionTenantStorage(
  slug: string,
  deps: StorageDeps,
): Promise<TenantStorage> {
  const { config } = deps;
  const bucket = tenantBucketName(slug);

  const makeBucket = deps.makeBucket ?? defaultMakeBucket(config);
  await makeBucket(bucket);

  const mint = deps.mintCredentials ?? defaultMintCredentials(config);
  const creds = await mint(bucket);

  return {
    bucket,
    endpoint: `${config.useSSL ? 'https' : 'http'}://${config.endpoint}:${config.port}`,
    region: config.region,
    ...creds,
  };
}

/** Skip record returned when MinIO is not configured. */
export interface StorageSkipped {
  skipped: true;
  reason: string;
}

/**
 * Provision storage for a tenant, or skip cleanly when MinIO is not
 * configured. Throws only when MinIO IS configured but provisioning fails —
 * the pipeline treats that as best-effort (audited, tenant still created),
 * see provisionTenant.
 */
export async function provisionTenantStorageOrDefault(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TenantStorage | StorageSkipped> {
  const config = loadStorageConfig(env);
  if (!config) {
    return { skipped: true, reason: 'MINIO_ENDPOINT not set — object storage skipped.' };
  }
  return provisionTenantStorage(slug, { config });
}