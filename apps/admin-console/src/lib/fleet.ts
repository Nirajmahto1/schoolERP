// ──────────────────────────────────────────────
// Fleet schema target version.
//
// The tenant fleet's target schema version is the number of committed
// migrations in packages/database/prisma/migrations. Read from disk (the same
// source the migration orchestrator uses) rather than duplicating a constant.
// ──────────────────────────────────────────────

import * as fs from "fs";
import * as path from "path";

export function latestSchemaVersionClient(): number {
  const dir = path.join(process.cwd(), "..", "..", "packages", "database", "prisma", "migrations");
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((d) => /^\d+_/.test(d)).length;
}
