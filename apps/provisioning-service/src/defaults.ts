// ──────────────────────────────────────────────
// India defaults seeding (BUILD_PLAN 1.2.4)
//
// A brand-new tenant database gets, without any human input:
//   • the school + first branch
//   • the current academic year
//   • the standard class ladder Nursery → XII
//   • a small set of fee structures every Indian school recognises
//   • the school's first BRANCH_ADMIN with a one-time setup link
//
// The setup token is deliberately NOT a real password: it is stored as a
// `$setup$<token>` marker in passwordHash and must be exchanged for a password
// on first login. Phase 3's identity service formalises this as invite tokens.
// ──────────────────────────────────────────────

import { randomBytes } from 'crypto';
import type { PrismaClient } from '@school-erp/database';

export const CLASS_LADDER: ReadonlyArray<{ name: string; numericOrder: number }> = [
  { name: 'NURSERY', numericOrder: 0 },
  { name: 'LKG', numericOrder: 1 },
  { name: 'UKG', numericOrder: 2 },
  { name: 'ONE', numericOrder: 3 },
  { name: 'TWO', numericOrder: 4 },
  { name: 'THREE', numericOrder: 5 },
  { name: 'FOUR', numericOrder: 6 },
  { name: 'FIVE', numericOrder: 7 },
  { name: 'SIX', numericOrder: 8 },
  { name: 'SEVEN', numericOrder: 9 },
  { name: 'EIGHT', numericOrder: 10 },
  { name: 'NINE', numericOrder: 11 },
  { name: 'TEN', numericOrder: 12 },
  { name: 'ELEVEN', numericOrder: 13 },
  { name: 'TWELVE', numericOrder: 14 },
];

export interface SeedDefaultsInput {
  legalName: string;
  slug: string;
  /** e.g. "2026-27". Defaults to the academic year spanning the current date. */
  academicYearName?: string;
  branchName?: string;
  /** The platform's app base URL, used to build the setup link. */
  appBaseUrl: string;
}

export interface SeedDefaultsResult {
  schoolId: string;
  branchId: string;
  academicYearId: string;
  adminUserId: string;
  setupToken: string;
  setupUrl: string;
}

export function currentAcademicYearName(now = new Date()): string {
  const year = now.getFullYear();
  // April is the natural Indian academic boundary.
  return now.getMonth() >= 3 ? `${year}-${String(year + 1).slice(2)}` : `${year - 1}-${String(year).slice(2)}`;
}

export async function seedIndiaDefaults(
  tenant: PrismaClient,
  input: SeedDefaultsInput,
): Promise<SeedDefaultsResult> {
  const yearName = input.academicYearName ?? currentAcademicYearName();
  const startYear = Number(yearName.split('-')[0]);
  const startDate = new Date(Date.UTC(startYear, 3, 1)); // April 1
  const endDate = new Date(Date.UTC(startYear + 1, 2, 31)); // March 31

  const school = await tenant.school.create({
    data: {
      name: input.legalName,
      code: input.slug.slice(0, 10).toUpperCase(),
      address: 'To be completed',
      city: 'To be completed',
      state: 'To be completed',
      pincode: '000000',
      phone: '0000000000',
      email: `${input.slug}@school.example.in`,
    },
  });

  const branch = await tenant.branch.create({
    data: {
      schoolId: school.id,
      name: input.branchName ?? 'Main Branch',
      code: 'MAIN',
      address: 'To be completed',
      phone: '0000000000',
      email: `${input.slug}-main@school.example.in`,
    },
  });

  const academicYear = await tenant.academicYear.create({
    data: {
      name: yearName,
      startDate,
      endDate,
      isCurrent: true,
      branchId: branch.id,
    },
  });

  // Class ladder + one section each.
  for (const cls of CLASS_LADDER) {
    const created = await tenant.class.create({
      data: {
        name: cls.name,
        numericOrder: cls.numericOrder,
        branchId: branch.id,
        academicYearId: academicYear.id,
        sections: { create: [{ name: 'A', capacity: 40 }] },
      },
    });
    void created;
  }

  // Fee structures a front-office expects out of the box.
  await tenant.feeStructure.createMany({
    data: [
      { name: 'Tuition Fee', branchId: branch.id, classIds: [], amount: 1500, frequency: 'MONTHLY', dueDay: 10 },
      { name: 'Annual Fee', branchId: branch.id, classIds: [], amount: 3000, frequency: 'ONE_TIME', dueDay: 5 },
      { name: 'Examination Fee', branchId: branch.id, classIds: [], amount: 500, frequency: 'ONE_TIME', dueDay: 5 },
    ],
  });

  // First BRANCH_ADMIN with a one-time setup token.
  const setupToken = randomBytes(24).toString('hex');
  const adminUser = await tenant.user.create({
    data: {
      email: `admin@${input.slug}.example.in`,
      passwordHash: `$setup$${setupToken}`,
      role: 'BRANCH_ADMIN',
      branchId: branch.id,
      schoolId: school.id,
    },
  });

  return {
    schoolId: school.id,
    branchId: branch.id,
    academicYearId: academicYear.id,
    adminUserId: adminUser.id,
    setupToken,
    setupUrl: `${input.appBaseUrl}/setup?token=${setupToken}`,
  };
}