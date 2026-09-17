// ──────────────────────────────────────────────
// Student login-email minting
//
// One rule, three callers (registration, admission, import): the student's
// login email is derived from THEIR NAME and the SCHOOL'S OWN domain — never
// a hardcoded one. Collisions are resolved with -2, -3… suffixes, retried
// against the database until unique (User.email is globally unique, so two
// "Anamika Gupta"s — even in different schools — get …-2, …-3).
//
// Domain resolution order (School row is the only source of truth):
//   1. website host  (www.stmarys.in → stmarys.in)
//   2. email domain  (admin@stmarys.in → stmarys.in)
//   3. fallback      student.<schoolCode>.school-erp.local
// ──────────────────────────────────────────────

import type { PrismaClient, Prisma } from '@school-erp/database';

/** "www.stmarys.in" | "https://stmarys.in/About" → "stmarys.in" */
function hostOf(raw: string): string | null {
  try {
    const host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
    return host.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** "Anamika" + "Gupta" → "anamika.gupta" (ASCII-safe, dot-free local part). */
function localPart(firstName: string, lastName: string): string {
  const slug = `${firstName}.${lastName}`
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9.]+/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');
  return slug || 'student';
}

/**
 * Mint a unique student login email. Retries with -2, -3… suffixes on
 * collisions (races can still throw P2002 — the caller's transaction handles
 * that the same way any other unique violation would).
 */
export async function mintStudentEmail(
  tx: Prisma.TransactionClient | PrismaClient,
  opts: { branchId: string; firstName: string; lastName: string },
): Promise<string> {
  const branch = await tx.branch.findUnique({
    where: { id: opts.branchId },
    select: { school: { select: { website: true, email: true, code: true } } },
  });
  const school = branch?.school;

  const domain =
    (school?.website && hostOf(school.website)) ||
    (school?.email && hostOf(school.email)) ||
    `student.${(school?.code ?? 'school').toLowerCase()}.school-erp.local`;
  const studentDomain = domain.startsWith('student.') ? domain : `student.${domain}`;

  const base = `${localPart(opts.firstName, opts.lastName)}@${studentDomain}`;

  // Fast path: no collision → no suffix.
  if (!(await tx.user.findUnique({ where: { email: base }, select: { id: true } }))) {
    return base;
  }

  for (let n = 2; ; n++) {
    const candidate = `${localPart(opts.firstName, opts.lastName)}-${n}@${studentDomain}`;
    if (!(await tx.user.findUnique({ where: { email: candidate }, select: { id: true } }))) {
      return candidate;
    }
  }
}
