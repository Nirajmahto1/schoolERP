// ──────────────────────────────────────────────
// First-run bootstrap (self-hosted VPS setup page)
//
// The operator's very first interaction with a fresh deployment: name the
// school, create the owner account, land in the dashboard. This replaces the
// provisioning CLI for the single-school shape — no terraform, no DB names,
// no setup tokens to chase through a terminal.
//
// Guard: the wizard only answers while the tenant database has no School row.
// The first successful run locks it permanently — from then on the status
// endpoint reports `provisioned: true` and every mutating route refuses.
// ──────────────────────────────────────────────

import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@school-erp/database';
import type { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { emailHash } from '@school-erp/tenant';
import { ensureAdminRolePermissions } from './permissions-catalog';

export interface BootstrapInput {
  schoolName: string;
  schoolCode: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  email: string;
  branchName: string;
  branchCode: string;
  adminEmail: string;
  adminPassword: string;
  logo?: string | null;
}

export interface BootstrapResult {
  schoolId: string;
  branchId: string;
  adminUserId: string;
}

/** Has this deployment already been set up? A School row IS the flag. */
export async function isProvisioned(prisma: PrismaClient): Promise<boolean> {
  const count = await prisma.school.count();
  return count > 0;
}

/** Shared password rule for the wizard and the later invite flows. */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < 10) return 'Password must be at least 10 characters.';
  if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter.';
  if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter.';
  if (!/[0-9]/.test(password)) return 'Password must contain a digit.';
  return null;
}

/**
 * Create the school, its first branch, and the owner (SUPER_ADMIN +
 * PRINCIPAL, mirroring the seed's shape so the UI shows the full nav), with
 * every permission the two admin roles need, the current academic year, and
 * the class ladder a new school expects. Directory + audit rows are written
 * by the route (they need the control plane; tests may run without one).
 */
export async function bootstrapTenant(
  prisma: PrismaClient,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  if (await isProvisioned(prisma)) {
    throw new BootstrapError('already-provisioned', 'This deployment already has a school. Sign in instead.');
  }
  const passwordProblem = validatePasswordStrength(input.adminPassword);
  if (passwordProblem) throw new BootstrapError('weak-password', passwordProblem);

  const schoolCode = input.schoolCode.trim().toUpperCase();
  const existingCode = await prisma.school.findUnique({ where: { code: schoolCode }, select: { id: true } });
  if (existingCode) throw new BootstrapError('school-code-taken', 'That school code is already in use.');

  const existingAdmin = await prisma.user.findUnique({
    where: { email: input.adminEmail.trim().toLowerCase() },
    select: { id: true },
  });
  if (existingAdmin) throw new BootstrapError('email-taken', 'An account with that email already exists.');

  // Permission catalog + admin grants first: the owner's first /me must
  // resolve a full permission set or the dashboard renders empty.
  await ensureAdminRolePermissions(prisma, ['SUPER_ADMIN', 'BRANCH_ADMIN']);

  const passwordHash = await bcrypt.hash(input.adminPassword, 12);
  const adminEmail = input.adminEmail.trim().toLowerCase();

  const school = await prisma.school.create({
    data: {
      name: input.schoolName.trim(),
      code: schoolCode,
      address: input.address.trim() || '—',
      city: input.city.trim() || '—',
      state: input.state.trim() || '—',
      pincode: input.pincode.trim() || '000000',
      phone: input.phone.trim() || '0000000000',
      email: input.email.trim().toLowerCase() || adminEmail,
      logo: input.logo ?? null,
      branches: {
        create: {
          name: input.branchName.trim() || 'Main Campus',
          code: input.branchCode.trim().toUpperCase() || 'MAIN',
          address: input.address.trim() || '—',
          phone: input.phone.trim() || '0000000000',
          email: input.email.trim().toLowerCase() || adminEmail,
        },
      },
    },
    include: { branches: true },
  });
  const branch = school.branches[0];

  // The academic year spanning today (April–March, the Indian boundary).
  const now = new Date();
  const startYear = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const yearName = `${startYear}-${String(startYear + 1).slice(2)}`;
  const academicYear = await prisma.academicYear.create({
    data: {
      name: yearName,
      startDate: new Date(Date.UTC(startYear, 3, 1)),
      endDate: new Date(Date.UTC(startYear + 1, 2, 31)),
      isCurrent: true,
      branchId: branch.id,
    },
  });

  // Class ladder + one section each — a new school starts with structure.
  const LADDER: Array<[string, number]> = [
    ['NURSERY', 0], ['LKG', 1], ['UKG', 2], ['ONE', 3], ['TWO', 4], ['THREE', 5],
    ['FOUR', 6], ['FIVE', 7], ['SIX', 8], ['SEVEN', 9], ['EIGHT', 10], ['NINE', 11],
    ['TEN', 12], ['ELEVEN', 13], ['TWELVE', 14],
  ];
  for (const [name, order] of LADDER) {
    await prisma.class.create({
      data: {
        name,
        numericOrder: order,
        branchId: branch.id,
        academicYearId: academicYear.id,
        sections: { create: [{ name: 'A', capacity: 40 }] },
      },
    });
  }

  const roles = await prisma.role.findMany({
    where: { code: { in: ['SUPER_ADMIN', 'PRINCIPAL'] } },
    select: { id: true, code: true },
  });
  const roleId = (code: string) => roles.find((r) => r.code === code)?.id;
  if (!roleId('SUPER_ADMIN')) {
    throw new BootstrapError('schema-stale', 'System roles missing — run `prisma migrate deploy` on this database first.');
  }

  const admin = await prisma.user.create({
    data: {
      email: adminEmail,
      passwordHash,
      defaultBranchId: branch.id,
      roleAssignments: {
        create: [
          { roleId: roleId('SUPER_ADMIN')! },
          { roleId: roleId('PRINCIPAL')!, branchId: branch.id },
        ],
      },
    },
  });

  return { schoolId: school.id, branchId: branch.id, adminUserId: admin.id };
}

export class BootstrapError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

// ── Branch management (in-app, post-setup) ──

export interface AddBranchInput {
  name: string;
  code: string;
  address?: string;
  phone?: string;
  email?: string;
  withAcademicYear?: boolean;
}

/**
 * Add a branch to the existing school. Academic years are per-branch in this
 * schema, so a new branch needs its own current year (and the class ladder)
 * before it can hold students or a timetable.
 */
export async function addBranch(prisma: PrismaClient, input: AddBranchInput): Promise<{ branchId: string; academicYearId: string | null }> {
  const school = await prisma.school.findFirst({ select: { id: true } });
  if (!school) throw new BootstrapError('not-provisioned', 'Run the setup wizard first.');

  const code = input.code.trim().toUpperCase();
  const clash = await prisma.branch.findFirst({ where: { schoolId: school.id, code }, select: { id: true } });
  if (clash) throw new BootstrapError('branch-code-taken', 'A branch with that code already exists.');

  const branch = await prisma.branch.create({
    data: {
      schoolId: school.id,
      name: input.name.trim(),
      code,
      address: input.address?.trim() || '—',
      phone: input.phone?.trim() || '0000000000',
      email: input.email?.trim() || `branch-${code.toLowerCase()}@school.local`,
    },
  });

  let academicYearId: string | null = null;
  if (input.withAcademicYear !== false) {
    const now = new Date();
    const startYear = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    const yearName = `${startYear}-${String(startYear + 1).slice(2)}`;
    const academicYear = await prisma.academicYear.create({
      data: {
        name: yearName,
        startDate: new Date(Date.UTC(startYear, 3, 1)),
        endDate: new Date(Date.UTC(startYear + 1, 2, 31)),
        isCurrent: true,
        branchId: branch.id,
      },
    });
    academicYearId = academicYear.id;
    for (const [name, order] of [
      ['NURSERY', 0], ['LKG', 1], ['UKG', 2], ['ONE', 3], ['TWO', 4], ['THREE', 5],
      ['FOUR', 6], ['FIVE', 7], ['SIX', 8], ['SEVEN', 9], ['EIGHT', 10], ['NINE', 11],
      ['TEN', 12], ['ELEVEN', 13], ['TWELVE', 14],
    ] as Array<[string, number]>) {
      await prisma.class.create({
        data: {
          name,
          numericOrder: order,
          branchId: branch.id,
          academicYearId: academicYear.id,
          sections: { create: [{ name: 'A', capacity: 40 }] },
        },
      });
    }
  }

  return { branchId: branch.id, academicYearId };
}

// ── Control-plane side effects (optional: tests run without one) ──

/**
 * Register the deployment in the control plane so logins route. Idempotent on
 * the school code — a re-run must not duplicate the Tenant row.
 *
 * `connRef` is this deployment's own DATABASE_URL: identity-service routes
 * directory hits to exactly that database, which for the single-DB VPS is
 * the same database the wizard just wrote. When there is no control plane at
 * all, registration is skipped and login falls back to identity's
 * single-database mode — both shapes reach the same login.
 */
export async function registerControlPlane(
  controlPlane: ControlPlaneClient,
  schoolCode: string,
  connRef: string,
  adminUserId: string,
  adminEmail: string,
): Promise<void> {
  const slug = schoolCode.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const tenant = await controlPlane.tenant.upsert({
    where: { slug },
    create: { slug, legalName: schoolCode, status: 'ACTIVE' },
    update: { status: 'ACTIVE' },
  });
  await controlPlane.tenantDatastore.upsert({
    where: { tenantId: tenant.id },
    create: {
      tenantId: tenant.id,
      kind: 'POSTGRES',
      connRef,
      schemaVersion: 0,
      lastMigratedAt: new Date(),
    },
    update: { connRef, lastMigratedAt: new Date() },
  });
  await controlPlane.userDirectory.upsert({
    where: { emailHash: emailHash(adminEmail) },
    create: { emailHash: emailHash(adminEmail), tenantId: tenant.id, userId: adminUserId },
    update: { tenantId: tenant.id, userId: adminUserId },
  });
  await controlPlane.provisionAudit.create({
    data: { actor: 'setup-wizard', action: 'tenant.bootstrap', tenantId: tenant.id, payload: { adminUserId, schoolCode } },
  });
}
