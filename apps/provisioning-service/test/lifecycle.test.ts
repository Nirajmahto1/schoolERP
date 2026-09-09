// ──────────────────────────────────────────────
// Tenant lifecycle tests (BUILD_PLAN 1.5)
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDotenv } from '@school-erp/config';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { TestDatabase } from '@school-erp/testing';
import {
  exportTenant,
  hardDeleteTenant,
  recountSeats,
  resumeTenant,
  scheduleTenantDeletion,
  suspendTenant,
} from '../src/lifecycle';

loadDotenv();

describe('tenant lifecycle', () => {
  let controlDb: TestDatabase;
  let controlPlane: ControlPlaneClient;
  let tenantId: string;
  let tenantDb: TestDatabase;

  beforeAll(async () => {
    controlDb = await TestDatabase.create(process.env.DATABASE_URL, { project: 'control-plane' });
    controlPlane = new ControlPlaneClient({ datasourceUrl: controlDb.url });

    tenantDb = await TestDatabase.create(process.env.DATABASE_URL);
    const tenant = await controlPlane.tenant.create({
      data: { slug: 'lifecycle-co', legalName: 'Lifecycle Co', status: 'ACTIVE' },
    });
    tenantId = tenant.id;
    await controlPlane.tenantDatastore.create({
      data: { tenantId, connRef: tenantDb.url, schemaVersion: 1 },
    });
    await controlPlane.subscription.create({
      data: {
        tenantId,
        planId: (
          await controlPlane.plan.create({
            data: { code: 'standard', name: 'Standard', pricePerStudentYear: 150, maxBranches: 3, maxStudents: 2000 },
          })
        ).id,
        periodStart: new Date('2026-04-01'),
        periodEnd: new Date('2027-03-31'),
        seats: 0,
        status: 'ACTIVE',
        billingAnchor: new Date('2026-04-01'),
      },
    });
  });

  afterAll(async () => {
    await tenantDb.teardown();
    await controlDb.teardown();
    await controlPlane.$disconnect();
  });

  it('suspends and resumes with audit trail', async () => {
    await suspendTenant(controlPlane, tenantId, 'non-payment');
    let tenant = await controlPlane.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant?.status).toBe('SUSPENDED');

    await resumeTenant(controlPlane, tenantId);
    tenant = await controlPlane.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant?.status).toBe('ACTIVE');

    const actions = await controlPlane.provisionAudit.findMany({
      where: { tenantId, action: { in: ['tenant.suspend', 'tenant.resume'] } },
      orderBy: { at: 'asc' },
    });
    expect(actions.map((a) => a.action)).toEqual(['tenant.suspend', 'tenant.resume']);
  });

  it('recounts seats from the tenant database', async () => {
    // Seed one active student so the count is non-trivial.
    const client = tenantDb.client();
    const school = await client.school.create({
      data: {
        name: 'Lifecycle Co',
        code: 'LIFE',
        address: 'Delhi',
        city: 'Delhi',
        state: 'DL',
        pincode: '110001',
        phone: '0110000000',
        email: 'life@school.example.test',
      },
    });
    const branch = await client.branch.create({
      data: {
        schoolId: school.id,
        name: 'Main',
        code: 'MAIN',
        address: 'Delhi',
        phone: '0110000000',
        email: 'life-main@school.example.test',
      },
    });
    const year = await client.academicYear.create({
      data: { name: '2026-27', startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), isCurrent: true, branchId: branch.id },
    });
    const cls = await client.class.create({
      data: { name: 'SIX', numericOrder: 8, branchId: branch.id, academicYearId: year.id },
    });
    const section = await client.section.create({ data: { name: 'A', classId: cls.id, capacity: 40 } });
    const user = await client.user.create({
      data: { email: 's@life.test', passwordHash: 'x', role: 'STUDENT', branchId: branch.id, schoolId: school.id },
    });
    const parent = await client.parent.create({
      data: {
        fatherName: 'F', fatherPhone: '9000000000', motherName: 'M', address: 'Delhi',
      },
    });
    await client.student.create({
      data: {
        userId: user.id,
        admissionNo: 'ADM-1',
        rollNo: '1',
        firstName: 'A',
        lastName: 'B',
        dateOfBirth: new Date('2013-01-01'),
        gender: 'MALE',
        classId: cls.id,
        sectionId: section.id,
        parentId: parent.id,
        address: 'Delhi',
        admissionDate: new Date('2026-04-01'),
        branchId: branch.id,
      },
    });
    await client.$disconnect();

    const count = await recountSeats(controlPlane, tenantId);
    expect(count).toBe(1);

    const sub = await controlPlane.subscription.findFirst({ where: { tenantId, status: 'ACTIVE' } });
    expect(sub?.seats).toBe(1);
  });

  it('exports every table in the tenant database', async () => {
    const dump = await exportTenant(controlPlane, tenantId);
    expect(dump.slug).toBe('lifecycle-co');
    const schools = dump.tables.find((t) => t.table === 'schools');
    expect(schools?.rows).toBe(1);
    const students = dump.tables.find((t) => t.table === 'students');
    expect(students?.rows).toBe(1);
  });

  it('schedules deletion, then hard-deletes with a certificate', async () => {
    const { deleteAfter } = await scheduleTenantDeletion(controlPlane, tenantId, 30);
    expect(deleteAfter > new Date()).toBe(true);

    const cert = await hardDeleteTenant(controlPlane, tenantId, process.env.DATABASE_URL as string);
    expect(cert).toContain('CERTIFICATE OF DELETION');
    expect(cert).toContain('lifecycle-co');

    expect(await controlPlane.tenant.count({ where: { id: tenantId } })).toBe(0);
    expect(await controlPlane.tenantDatastore.count({ where: { tenantId } })).toBe(0);
  });
});