import { randomUUID } from 'crypto';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { PrismaClient } from '@school-erp/database';

/** Resolve the Prisma CLI entry so we never shell out to `npx` (Windows needs npx.cmd). */
function prismaCli(): string {
  const databaseDir = path.resolve(__dirname, '..', '..', 'database');
  return require.resolve('prisma/build/index.js', { paths: [databaseDir] });
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

  /** Create the schema and apply every committed migration. */
  static async create(baseUrl: string): Promise<TestDatabase> {
    const schema = `test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const db = new TestDatabase(schema, withSchema(baseUrl, schema));
    await db.migrate();
    return db;
  }

  async migrate(): Promise<void> {
    const databaseDir = path.resolve(__dirname, '..', '..', 'database');
    // Call the CLI via node directly — `npx` is npx.cmd on Windows (ENOENT with
    // execFileSync) and `spawn().output()` needs Node >= 20.12. stderr is
    // captured for the error report.
    try {
      execFileSync(
        process.execPath,
        [prismaCli(), 'migrate', 'deploy'],
        {
          cwd: databaseDir,
          env: { ...process.env, DATABASE_URL: this.url },
          stdio: 'pipe',
        },
      );
    } catch (err) {
      const stderr = (err as Error & { stderr?: Buffer }).stderr?.toString() ?? (err as Error).message;
      throw new Error(`prisma migrate deploy failed for schema ${this.schema}: ${stderr}`);
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