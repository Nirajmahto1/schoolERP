// ──────────────────────────────────────────────
// Exam trigger tests (§5.6: exam schedule + result published)
//
// Exam communication has a hard safety rule from 2.6.5: nothing is
// parent-visible before PUBLISHED. The results trigger enforces that at
// the API boundary (409 unless PUBLISHED), and both triggers dedupe on
// the NotificationLog tags so re-fires never spam the whole parent body.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { TestDatabase, assertionFor, seedTenant, testKeypair, type TenantSeed } from '@school-erp/testing';
import { createCommunicationApp } from '../src/index';

describe('exam triggers', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let keypair: ReturnType<typeof testKeypair>;
  let seed: TenantSeed;
  let app: Express;
  let examSeq = 0;

  const asComm = (): string =>
    assertionFor(keypair, 'communication-service', {
      userId: seed.adminUserId,
      email: 'admin@examtrig.test',
      tenantId: seed.schoolId,
      branchId: seed.branchId,
      roles: ['BRANCH_ADMIN'],
      permissions: [],
    } as never);

  async function seedExam(daysFromNow: number, status: 'ENTRY' | 'SUBMITTED' | 'VERIFIED' | 'PUBLISHED' = 'VERIFIED') {
    examSeq += 1;
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + daysFromNow);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 3);
    return prisma.examination.create({
      data: {
        branchId: seed.branchId,
        academicYearId: seed.academicYearId,
        name: `Term ${examSeq} Examination`,
        startDate: start,
        endDate: end,
        status,
      },
    });
  }

  beforeAll(async () => {
    db = await TestDatabase.create(
      process.env.DATABASE_URL ?? 'postgresql://school_erp:Niraj1307!@localhost:5432/school_erp',
      { project: 'database' },
    );
    prisma = db.client();
    seed = await seedTenant(prisma, { code: 'EXAMTRIG', name: 'Exam Trigger School' });
    keypair = testKeypair();
    app = createCommunicationApp({
      env: { INTERNAL_ASSERTION_PUBLIC_KEY: keypair.publicKey },
      prisma,
      messaging: { whatsapp: null, sms: null, quietHours: { start: 2, end: 3 } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.teardown();
  });

  it('schedule scan queues one notice per opted-in guardian for in-window exams', async () => {
    const exam = await seedExam(5); // starts in 5 days, inside the 7-day window

    const scan = await request(app)
      .post('/exam-triggers/schedule-scan')
      .set('x-internal-assertion', asComm())
      .send({ drain: true })
      .expect(200);

    expect(scan.body.examsFound).toBeGreaterThanOrEqual(1);
    expect(scan.body.noticesQueued).toBeGreaterThanOrEqual(1);
    const log = await prisma.notificationLog.findFirstOrThrow({ where: { template: `exam_schedule:${exam.id}` } });
    expect(log.channel).toBe('WHATSAPP');
    expect(log.body).toContain(exam.name);
    expect(log.body).toContain('begins');
    // drain:true ran with no providers configured → the row failed closed
    // with the full chain trail (correct dev outcome; providers deliver).
    expect(['SENT', 'FAILED']).toContain(log.status);
  });

  it('exams outside the window and already-published exams never notify', async () => {
    await seedExam(30); // far outside the 7-day window
    await seedExam(2, 'PUBLISHED'); // published = results phase, not schedule

    const before = await prisma.notificationLog.count({ where: { template: { startsWith: 'exam_schedule:' } } });
    const scan = await request(app)
      .post('/exam-triggers/schedule-scan')
      .set('x-internal-assertion', asComm())
      .send({})
      .expect(200);
    const after = await prisma.notificationLog.count({ where: { template: { startsWith: 'exam_schedule:' } } });

    expect(scan.body.noticesQueued).toBe(0);
    expect(after).toBe(before);
  });

  it('schedule scan is idempotent per exam (re-scan queues nothing)', async () => {
    const scan = await request(app)
      .post('/exam-triggers/schedule-scan')
      .set('x-internal-assertion', asComm())
      .send({})
      .expect(200);

    expect(scan.body.alreadyNotified).toBeGreaterThanOrEqual(1); // the 5-day exam from before
    expect(scan.body.noticesQueued).toBe(0);
  });

  it('results-published queues notices; refuses non-PUBLISHED exams with 409', async () => {
    const published = await seedExam(-10, 'PUBLISHED');
    const verified = await seedExam(-10, 'VERIFIED'); // not published yet

    // VERIFIED exam → 409 state-conflict.
    await request(app)
      .post('/exam-triggers/results-published')
      .set('x-internal-assertion', asComm())
      .send({ examinationId: verified.id })
      .expect(409);

    // PUBLISHED exam → queues one row per guardian.
    const res = await request(app)
      .post('/exam-triggers/results-published')
      .set('x-internal-assertion', asComm())
      .send({ examinationId: published.id, drain: true })
      .expect(200);
    expect(res.body.noticesQueued).toBeGreaterThanOrEqual(1);

    const log = await prisma.notificationLog.findFirstOrThrow({ where: { template: `exam_results:${published.id}` } });
    expect(log.body).toContain(published.name);
    expect(log.body).toContain('parent portal');

    // Re-fire → alreadyNotified, no new rows.
    const again = await request(app)
      .post('/exam-triggers/results-published')
      .set('x-internal-assertion', asComm())
      .send({ examinationId: published.id })
      .expect(200);
    expect(again.body.alreadyNotified).toBe(1);
    expect(again.body.noticesQueued).toBe(0);
  });

  it('unknown exam ids 404; validation catches missing examinationId', async () => {
    await request(app)
      .post('/exam-triggers/results-published')
      .set('x-internal-assertion', asComm())
      .send({ examinationId: 'doesnotexist' })
      .expect(404);

    await request(app)
      .post('/exam-triggers/results-published')
      .set('x-internal-assertion', asComm())
      .send({})
      .expect(400);
  });
});
