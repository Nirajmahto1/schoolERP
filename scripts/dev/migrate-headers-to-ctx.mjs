#!/usr/bin/env node
// ──────────────────────────────────────────────
// Codemod: trusted headers -> verified assertion context
//
// Replaces every
//     const branchId = req.headers['x-branch-id'] as string;
// with
//     const { branchId } = ctx(req);
//
// and inserts the `ctx` import where needed. 40+ call sites across five
// services is too many to hand-edit reliably, and a missed site is a security
// hole rather than a cosmetic bug.
//
// Run:   node scripts/dev/migrate-headers-to-ctx.mjs
// Check: node scripts/dev/migrate-headers-to-ctx.mjs --check   (CI gate)
// ──────────────────────────────────────────────

import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';

const CHECK_ONLY = process.argv.includes('--check');
const ROOT = process.cwd();

const HEADER_TO_CTX = {
  'x-user-id': 'userId',
  'x-user-email': 'email',
  'x-branch-id': 'branchId',
  'x-school-id': 'tenantId',
  'x-tenant-id': 'tenantId',
};

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', '__pycache__']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const files = walk(join(ROOT, 'apps'));

// `const foo = req.headers['x-bar'] as string;` (also `let`, also no cast)
const DECL =
  /([ \t]*)(?:const|let)[ \t]+(\w+)[ \t]*=[ \t]*req\.headers\[['"]([a-z-]+)['"]\](?:[ \t]+as[ \t]+[^;]+?)?[ \t]*;/g;

// Bare inline uses
const INLINE = /req\.headers\[['"]([a-z-]+)['"]\](?:[ \t]+as[ \t]+(?:string|any))?/g;

let filesChanged = 0;
let sitesChanged = 0;
const remaining = [];

for (const path of files) {
  const rel = relative(ROOT, path).replace(/\\/g, '/');
  let source = readFileSync(path, 'utf8');
  const original = source;
  const used = new Set();

  source = source.replace(DECL, (match, indent, varName, header) => {
    const field = HEADER_TO_CTX[header];
    if (!field) return match;
    used.add(field);
    sitesChanged++;
    return varName === field
      ? `${indent}const { ${field} } = ctx(req);`
      : `${indent}const { ${field}: ${varName} } = ctx(req);`;
  });

  // Role reads: the old code treated this as a single string; ctx exposes an array.
  source = source.replace(
    /req\.headers\[['"]x-user-role['"]\](?:[ \t]+as[ \t]+(?:string|any))?/g,
    () => {
      used.add('roles');
      sitesChanged++;
      return 'ctx(req).roles';
    },
  );

  source = source.replace(INLINE, (match, header) => {
    const field = HEADER_TO_CTX[header];
    if (!field) return match;
    used.add(field);
    sitesChanged++;
    return `ctx(req).${field}`;
  });

  if (used.size > 0 && !/from '@school-erp\/auth'/.test(source)) {
    const imports = [...source.matchAll(/^import [^\n]*?;$/gm)];
    if (imports.length > 0) {
      const last = imports[imports.length - 1];
      const at = last.index + last[0].length;
      source = `${source.slice(0, at)}\nimport { ctx } from '@school-erp/auth';${source.slice(at)}`;
    } else {
      source = `import { ctx } from '@school-erp/auth';\n${source}`;
    }
  }

  if (source !== original) {
    filesChanged++;
    if (!CHECK_ONLY) writeFileSync(path, source, 'utf8');
  }

  for (const m of source.matchAll(
    /req\.headers\[['"](x-(?:user|branch|school|tenant)[a-z-]*)['"]\]/g,
  )) {
    remaining.push(`${rel}: ${m[1]}`);
  }
}

if (CHECK_ONLY) {
  if (remaining.length > 0) {
    console.error(
      `✗ ${remaining.length} trusted-header identity read(s) still present:\n` +
        remaining.map((r) => `    ${r}`).join('\n') +
        '\n\n  Identity must come from ctx(req), which is populated only after a\n' +
        '  gateway-signed assertion is verified. See ADR-3 in docs/BUILD_PLAN.md.',
    );
    process.exit(1);
  }
  console.log('✓ No trusted-header identity reads found.');
  process.exit(0);
}

console.log(`✓ Rewrote ${sitesChanged} call site(s) across ${filesChanged} file(s).`);
if (remaining.length > 0) {
  console.error(
    `⚠ ${remaining.length} site(s) need manual attention:\n` +
      remaining.map((r) => `    ${r}`).join('\n'),
  );
  process.exit(1);
}
