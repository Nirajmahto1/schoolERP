import { randomUUID } from 'crypto';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { PrismaClient } from '@school-erp/database';

/** Every Prisma project the harness can migrate (BUILD_PLAN 0.9 / 1.1). */
export type PrismaProject = 'database' | 'control-plane';

interface ProjectSpec {
  /** Directory name under packages/. */
  dir: string;
  /** The env var that project's datasource block reads. */
  envVar: string;
}

const PROJECTS: Record<PrismaProject, ProjectSpec> = {
  database: { dir: 'database', envVar: 'DATABASE_URL' },
  'control-plane': { dir: 'control-plane', envVar: 'CONTROL_PLANE_DATABASE_URL' },
};

/** Resolve the Prisma CLI entry so we never shell out to `npx` (Windows needs npx.cmd). */
function prismaCli(project: PrismaProject): string {
  const projectDir = path.resolve(__dirname, '..', '..', PROJECTS[project].dir);
  return require.resolve('prisma/build/index.js', { paths: [projectDir] });
}

/**
 * Point a postgres connection string at a specific schema.
 * Preserves every other query parameter (pgbouncer mode etc.).
 */
export function withSchema(url: string, schema: string): string {
  const [base, query] = url.split('?');
  const rest = (query ?? '')
    .split('&')
    .filter((p) => p && !p.startsWith('schema='))
    .join('&');
  return rest ? `${base}?schema=${schema}&${rest}` : `${base}?schema=${schema}`;
}

/**
 * A schema-isolated ephemeral Postgres database.
 *
 * We deliberately avoid a new DATABASE per suite (and Docker) — a unique schema
 * with migrations applied by `prisma migrate deploy` gives the same isolation
 * with a fraction of the setup, and keeps CI portable (a Postgres service
 * container is enough). Every schema is dropped on teardown.
 */
export class TestDatabase {
  readonly schema: string;
  /** Connection string for Prisma clients used inside the test. */
  readonly url: string;

  private constructor(schema: string, url: string) {
    this.schema = schema;
    this.url = url;
  }

  /** Create the schema and apply every committed migration for a project. */
  static async create(
    baseUrl: string | undefined,
    options: { project?: PrismaProject } = {},
  ): Promise<TestDatabase> {
    if (!baseUrl) {
      throw new Error(
        'DATABASE_URL is not set. Point it at a scratch Postgres before running ' +
        'tests (the harness creates and drops throwaway schemas on it). In CI it ' +
        'comes from the workflow env on the test job.',
      );
    }
    const project = options.project ?? 'database';
    const schema = `test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const db = new TestDatabase(schema, withSchema(baseUrl, schema));
    await db.migrate(project);
    return db;
  }

  async migrate(project: PrismaProject = 'database'): Promise<void> {
    const spec = PROJECTS[project];
    const projectDir = path.resolve(__dirname, '..', '..', spec.dir);
    // Call the CLI via node directly — `npx` is npx.cmd on Windows (ENOENT with
    // execFileSync) and `spawn().output()` needs Node >= 20.12. stderr is
    // captured for the error report.
    try {
      execFileSync(
        process.execPath,
        [prismaCli(project), 'migrate', 'deploy'],
        {
          cwd: projectDir,
          env: { ...process.env, [spec.envVar]: this.url },
          stdio: 'pipe',
        },
      );
    } catch (err) {
      const stderr = (err as Error & { stderr?: Buffer }).stderr?.toString() ?? (err as Error).message;
      throw new Error(`prisma migrate deploy (${project}) failed for schema ${this.schema}: ${stderr}`);
    }
  }

  /** Drop the schema entirely. Safe to call once. */
  async teardown(): Promise<void> {
    const admin = new PrismaClient({ datasourceUrl: withSchema(this.url, 'public') });
    try {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`);
    } finally {
      await admin.$disconnect();
    }
  }

  /** A client bound to this suite's schema. */
  client(): PrismaClient {
    return new PrismaClient({ datasourceUrl: this.url });
  }
}