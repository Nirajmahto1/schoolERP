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
}

export async function seedTenant(
  prisma: PrismaClient,
  seed: { code: string; name: string },
): Promise<TenantSeed> {
  const school = await prisma.school.create({
    data: {
      name: seed.name,
      code: seed.code,
      address: 'Test Address',
      city: 'Test City',
      state: 'Test State',
      pincode: '110001',
      phone: '0110000000',
      email: `${seed.code}@school.example.test`,
    },
  });

  const branch = await prisma.branch.create({
    data: {
      schoolId: school.id,
      name: 'Main Branch',
      code: 'MAIN',
      address: 'Test Address',
      phone: '0110000000',
      email: `${seed.code}-main@school.example.test`,
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
      email: `admin@${seed.code}.example.test`,
      passwordHash: '$2b$12$not-a-real-bcrypt-hash',
      role: 'BRANCH_ADMIN',
      branchId: branch.id,
      schoolId: school.id,
    },
  });

  // A student + their parent + user accounts.
  const parentUser = await prisma.user.create({
    data: {
      email: `parent@${seed.code}.example.test`,
      passwordHash: '$2b$12$not-a-real-bcrypt-hash',
      role: 'PARENT',
      branchId: branch.id,
      schoolId: school.id,
    },
  });

  const parent = await prisma.parent.create({
    data: {
      userId: parentUser.id,
      fatherName: 'Test Father',
      fatherPhone: `90000000${seed.code.slice(0, 2)}`,
      motherName: 'Test Mother',
      address: 'Test Address',
    },
  });

  const studentUser = await prisma.user.create({
    data: {
      email: `${seed.code}-student@example.test`,
      passwordHash: '$2b$12$not-a-real-bcrypt-hash',
      role: 'STUDENT',
      branchId: branch.id,
      schoolId: school.id,
    },
  });

  const student = await prisma.student.create({
    data: {
      userId: studentUser.id,
      admissionNo: `ADM-${seed.code}`,
      rollNo: '1',
      firstName: seed.name,
      lastName: 'Student',
      dateOfBirth: new Date('2013-05-10'),
      gender: 'MALE',
      classId: cls.id,
      sectionId: section.id,
      parentId: parent.id,
      address: 'Test Address',
      admissionDate: new Date('2026-04-01'),
      branchId: branch.id,
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
  };
}