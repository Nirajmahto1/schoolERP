import { PrismaClient } from '@school-erp/database';

/**
 * One school's worth of records, used by the cross-tenant isolation suite.
 * Two calls with different `code` values produce two fully disjoint tenants.
 */
export interface TenantSeed {
  schoolId: string;
  branchId: string;
  academicYearId: string;
  classId: string;
  sectionId: string;
  studentId: string;
  studentUserId: string;
  adminUserId: string;
  guardianUserId: string;
}

export async function seedTenant(
  prisma: PrismaClient,
  seed: { code: string; name: string },
): Promise<TenantSeed> {
  // User emails must be lowercase — the login path lowercases submitted
  // addresses before lookup, and Postgres comparison is case-sensitive.
  const code = seed.code.toLowerCase();
  const school = await prisma.school.create({
    data: {
      name: seed.name,
      code: seed.code,
      address: 'Test Address',
      city: 'Test City',
      state: 'Test State',
      pincode: '110001',
      phone: '0110000000',
      email: `${code}@school.example.test`,
    },
  });

  const branch = await prisma.branch.create({
    data: {
      schoolId: school.id,
      name: 'Main Branch',
      code: 'MAIN',
      address: 'Test Address',
      phone: '0110000000',
      email: `${code}-main@school.example.test`,
    },
  });

  const academicYear = await prisma.academicYear.create({
    data: {
      name: '2026-27',
      startDate: new Date('2026-04-01'),
      endDate: new Date('2027-03-31'),
      isCurrent: true,
      branchId: branch.id,
    },
  });

  const cls = await prisma.class.create({
    data: {
      name: 'SIX',
      numericOrder: 6,
      branchId: branch.id,
      academicYearId: academicYear.id,
    },
  });

  const section = await prisma.section.create({
    data: { name: 'A', classId: cls.id, capacity: 40 },
  });

  // An administrator for this tenant.
  const adminUser = await prisma.user.create({
    data: {
      email: `admin@${code}.example.test`,
      passwordHash: '$2b$12$not-a-real-bcrypt-hash',
      defaultBranchId: branch.id,
      roleAssignments: { create: { roleId: 'sys_branch_admin', branchId: branch.id } },
    },
  });

  // A guardian with portal access.
  const guardianUser = await prisma.user.create({
    data: {
      email: `parent@${code}.example.test`,
      passwordHash: '$2b$12$not-a-real-bcrypt-hash',
      defaultBranchId: branch.id,
      roleAssignments: { create: { roleId: 'sys_parent', branchId: branch.id } },
    },
  });

  const guardian = await prisma.guardian.create({
    data: {
      userId: guardianUser.id,
      fullName: 'Test Father',
      phone: `90000000${code.slice(0, 2)}`,
      email: `parent@${code}.example.test`,
    },
  });

  const studentUser = await prisma.user.create({
    data: {
      email: `${code}-student@example.test`,
      passwordHash: '$2b$12$not-a-real-bcrypt-hash',
      defaultBranchId: branch.id,
      roleAssignments: { create: { roleId: 'sys_student', branchId: branch.id } },
    },
  });

  const student = await prisma.student.create({
    data: {
      userId: studentUser.id,
      admissionNo: `ADM-${seed.code}`,
      firstName: seed.name,
      lastName: 'Student',
      dateOfBirth: new Date('2013-05-10'),
      gender: 'MALE',
      address: 'Test Address',
      admissionDate: new Date('2026-04-01'),
      branchId: branch.id,
      guardians: { create: { guardianId: guardian.id, relation: 'FATHER', isPrimary: true } },
      enrollments: {
        create: {
          academicYearId: academicYear.id,
          branchId: branch.id,
          classId: cls.id,
          sectionId: section.id,
          rollNo: '1',
          status: 'ENROLLED',
          fromDate: new Date('2026-04-01'),
        },
      },
    },
  });

  return {
    schoolId: school.id,
    branchId: branch.id,
    academicYearId: academicYear.id,
    classId: cls.id,
    sectionId: section.id,
    studentId: student.id,
    studentUserId: studentUser.id,
    adminUserId: adminUser.id,
    guardianUserId: guardianUser.id,
  };
}