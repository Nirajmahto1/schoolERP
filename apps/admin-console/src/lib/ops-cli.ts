import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Heavy platform operations (provisioning, fleet migration) run as the
 * provisioning-service CLI in a child process, NOT in-process.
 *
 * The CLI resolves filesystem paths from its own module location and shells
 * out to the Prisma CLI — inside the Next.js server runtime, Turbopack
 * bundles workspace packages into virtual paths ([project]/...), so
 * `__dirname` and `require.resolve` no longer point at real files and the
 * spawn fails with ENOENT. Running the CLI as a plain node process restores
 * real paths.
 *
 * The CLI's `--json` mode prints only the machine-readable result.
 */
export function runOpsCli(args: string[]): string {
  const root = findRepoRoot();
  const cli = path.join(root, "apps", "provisioning-service", "dist", "cli.js");
  if (!fs.existsSync(cli)) {
    throw new Error(
      "provisioning-service is not built (dist/cli.js missing). Run `npm run build` first.",
    );
  }
  const out = execFileSync(process.execPath, [cli, ...args, "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.trim();
}

/** Walk up from cwd until a package.json declaring `workspaces` is found. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = start;
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (Array.isArray(pkg.workspaces)) return dir;
      } catch {
        // Not a parseable package.json — keep walking.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error("Could not locate the monorepo root (no package.json with workspaces).");
    }
    dir = parent;
  }
}