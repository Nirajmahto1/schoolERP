// ──────────────────────────────────────────────
// Fleet metering tests (BUILD_PLAN 4.2.4)
//
// Uses TWO databases like production: a control-plane schema (usage records
// land here) and a tenant schema seeded with known counts. Each test gets a
// FRESH tenant schema so counts never accumulate. Asserts the job measures
// reality — not estimates — and that one broken tenant never stops the pass.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { PrismaClient as TenantClient } from '@school-erp/database';
import { TestDatabase } from '@school-erp/testing';
import { measureTenant, runFleetMeteringPass, type TenantUsageSample } from '../src/metering';

let controlDb: TestDatabase;
let cp: ControlPlaneClient;

const CONTROL_URL =
  process.env.CONTROL_PLANE_DATABASE_URL ??
  'postgresql://school_erp:Niraj1307!@localhost:5432/school_erp_control';

beforeAll(async () => {
  controlDb = await TestDatabase.create(CONTROL_URL, { project: 'control-plane' });
  cp = new ControlPlaneClient({ datasourceUrl: controlDb.url });
});

afterAll(async () => {
  await cp.$disconnect();
  await controlDb.teardown();
});

let dbSeq = 0;

/** A fresh throwaway tenant schema + the control-plane rows pointing at it. */
async function freshTenant(slug: string, status: 'ACTIVE' | 'TRIAL' = 'ACTIVE') {
  const tdb = await TestDatabase.create(CONTROL_URL, { project: 'database' });
  dbSeq++;
  const tenant = await cp.tenant.create({
    data: {
      slug: `${slug}-${dbSeq}`,
      legalName: `School ${slug}`,
      status,
      datastore: { create: { kind: 'POSTGRES', connRef: tdb.url, schemaVersion: 9999 } },
    },
  });
  return { tdb, tenant };
}

/** Minimal control-plane tenant with an unreachable datastore. */
async function deadTenant(slug: string) {
  dbSeq++;
  return cp.tenant.create({
    data: {
      slug: `${slug}-${dbSeq}`,
      legalName: `School ${slug}`,
      status: 'ACTIVE',
      datastore: { create: { kind: 'POSTGRES', connRef: 'postgresql://nobody:nope@localhost:9/no_such_db', schemaVersion: 1 } },
    },
  });
}

/** Seed a tenant schema with known metering-relevant counts. */
async function seedTenantData(db: TestDatabase, opts: { students: number; staff: number; docs: Array<[number, boolean]>; notifications: Array<{ cost: number | null; daysAgo: number }> }) {
  const t = new TenantClient({ datasourceUrl: db.url });
  const school = await t.school.create({
    data: {
      name: 'Metering Test School', code: `MTS-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      address: 'x', city: 'x', state: 'MH', pincode: '400001', phone: 'x',
      email: `mts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@t.test`,
    },
  });
  const branch = await t.branch.create({
    data: {
      schoolId: school.id, name: 'Main', code: `M-${Math.random().toString(36).slice(2, 6)}`,
      address: 'x', phone: 'x', email: `br-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@t.test`,
    },
  });
  const mkUser = (i: number) => ({
    email: `p${i}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${Math.random().toString(36).slice(2, 6)}@t.test`,
    passwordHash: 'x',
  });

  for (let i = 0; i < opts.students; i++) {
    await t.student.create({
      data: {
        admissionNo: `ADM-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
        firstName: 'S', lastName: String(i), dateOfBirth: new Date(), gender: 'MALE',
        address: 'x', admissionDate: new Date(), isActive: true, branch: { connect: { id: branch.id } },
        user: { create: mkUser(i) },
      },
    });
  }
  for (let i = 0; i < opts.staff; i++) {
    await t.staff.create({
      data: {
        employeeId: `EMP-${i}-${Math.random().toString(36).slice(2, 6)}`, firstName: 'T', lastName: String(i), dateOfBirth: new Date(),
        gender: 'MALE', designation: 'Teacher', department: 'Academics', qualification: 'B.Ed',
        joinDate: new Date(), salary: 30000, address: 'x', phone: 'x', isActive: true,
        branch: { connect: { id: branch.id } }, user: { create: mkUser(1000 + i) },
      },
    });
  }
  if (opts.docs.length > 0) {
    // ONE uploader owns every document — so the staff count stays exactly
    // opts.staff + 1 and the test can assert it precisely.
    const uploader = await t.staff.create({
      data: {
        employeeId: `DOC-${Math.random().toString(36).slice(2, 6)}`, firstName: 'D', lastName: 'O', dateOfBirth: new Date(),
        gender: 'MALE', designation: 'Admin', department: 'Office', qualification: 'BA',
        joinDate: new Date(), salary: 20000, address: 'x', phone: 'x',
        branch: { connect: { id: branch.id } }, user: { create: mkUser(2000) },
      },
    });
    for (const [size, deleted] of opts.docs) {
      await t.document.create({
        data: {
          type: 'OTHER', title: `d${size}-${Math.random()}`, s3Key: `k${size}-${Math.random()}`, mimeType: 'application/pdf',
          sizeBytes: size, ...(deleted ? { deletedAt: new Date() } : {}), staffId: uploader.id,
        },
      });
    }
  }
  for (const n of opts.notifications) {
    await t.notificationLog.create({
      data: {
        branchId: branch.id, channel: 'WHATSAPP', recipientType: 'GUARDIAN', recipientId: 'g1',
        status: 'SENT', cost: n.cost,
        ...(n.daysAgo > 0 ? { createdAt: new Date(Date.now() - n.daysAgo * 86_400_000) } : {}),
      },
    });
  }
  await t.$disconnect();
}

describe('measureTenant', () => {
  it('collects real students/staff/storage/credit counts into the control plane', async () => {
    const { tdb, tenant } = await freshTenant('meter-ok');
    try {
      await seedTenantData(tdb, {
        students: 12,
        staff: 3,
        docs: [[1024, false], [2048, false], [9999, true]], // the deleted one is excluded
        notifications: [{ cost: 0.25, daysAgo: 1 }, { cost: 0.32, daysAgo: 2 }, { cost: 5.0, daysAgo: 40 }], // 40d old = outside window
      });

      const usage = await measureTenant(cp, tenant.id, tdb.url);

      expect(usage.students).toBe(12);
      expect(usage.staff).toBe(4); // 3 seeded + 1 document uploader
      expect(usage.storage_bytes).toBe(1024 + 2048); // soft-deleted document excluded
      expect(usage.messaging_credits).toBe(2); // message units in the trailing 30 days (40d-old excluded)

      // Four samples written, latest-per-metric matches.
      const rows = await cp.usageRecord.findMany({ where: { tenantId: tenant.id } });
      expect(rows).toHaveLength(4);
      const byMetric = Object.fromEntries(rows.map((r) => [r.metric, Number(r.value)]));
      expect(byMetric['students']).toBe(12);
      expect(byMetric['storage_bytes']).toBe(3072);
      expect(byMetric['messaging_credits']).toBe(2);
    } finally {
      await tdb.teardown();
    }
  });

  it('counts message units regardless of whether costs are stamped', async () => {
    const { tdb, tenant } = await freshTenant('meter-units');
    try {
      await seedTenantData(tdb, {
        students: 1, staff: 0, docs: [],
        notifications: [{ cost: null, daysAgo: 0 }, { cost: 0.25, daysAgo: 3 }],
      });

      const usage = await measureTenant(cp, tenant.id, tdb.url);
      expect(usage.messaging_credits).toBe(2); // units, not rupees — BigInt-safe by construction
    } finally {
      await tdb.teardown();
    }
  });

  it('treats an empty tenant as honest zeros', async () => {
    const { tdb, tenant } = await freshTenant('meter-empty');
    try {
      const usage = await measureTenant(cp, tenant.id, tdb.url);
      expect(usage.students).toBe(0);
      expect(usage.staff).toBe(0);
      expect(usage.storage_bytes).toBe(0);
      expect(usage.messaging_credits).toBe(0);
    } finally {
      await tdb.teardown();
    }
  });
});

describe('runFleetMeteringPass', () => {
  it('measures every active tenant and isolates per-tenant failures', { timeout: 60_000 }, async () => {
    const { tdb, tenant: okTenant } = await freshTenant('fleet-ok');
    try {
      await seedTenantData(tdb, { students: 5, staff: 1, docs: [[512, false]], notifications: [] });
      const dead = await deadTenant('fleet-dead');

      const result = await runFleetMeteringPass(cp, { actor: 'test' });

      // Assert on OUR two tenants — earlier tests' tenants legitimately
      // remain in the control-plane schema (their datastores now point at
      // torn-down schemas, which exercises the failure-isolation path).
      const ok = result.samples.find((s) => s.tenantId === okTenant.id);
      const failed = result.samples.find((s) => s.tenantId === dead.id);
      expect(ok).toBeTruthy();
      expect(failed).toBeTruthy();
      expect(ok?.ok).toBe(true);
      expect(ok?.usage.students).toBe(5);
      expect(ok?.usage.storage_bytes).toBe(512);
      expect(failed?.ok).toBe(false);
      expect(failed?.error).toBeTruthy();
      expect(result.succeeded + result.failed).toBe(result.tenants);
    } finally {
      await tdb.teardown();
    }
  });
});
