// ──────────────────────────────────────────────
// Live absence-alert trigger tests (BUILD_PLAN 5.6 #1 / GATE 5)
//
// The teacher taps "mark" and the parent's phone should buzz within minutes.
// These prove the wiring: /mark fires the communication-service scan after
// commit, carrying the marker's identity in a freshly minted 30-second
// assertion — and that a dead/slow communication-service can never fail or
// even slow the marking response (the morning sweep is the safety net).
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { TestDatabase, assertionFor, seedTenant, testKeypair, type TenantSeed } from '@school-erp/testing';
import { createAttendanceApp } from '../src/index';
import { mintAssertion, verifyAssertion } from '@school-erp/auth';
import { generateKeyPairSync } from 'crypto';

const PEER_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEER_PRIVATE = PEER_KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PEER_PUBLIC = PEER_KEYS.publicKey.export({ type: 'spki', format: 'pem' }).toString();

describe('live absence-alert fire from /mark', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let keypair: ReturnType<typeof testKeypair>;
  let seed: TenantSeed;
  let app: Express;

  /** What the "communication-service" stub received. */
  const peerCalls: Array<{ url: string; assertion: string | undefined; body: unknown }> = [];
  let peerStatus = 200;
  let peerReject = false;

  const asTeacher = (): string =>
    assertionFor(keypair, 'attendance-service', {
      userId: seed.adminUserId,
      email: 'admin@att.test',
      tenantId: seed.schoolId,
      branchId: seed.branchId,
      roles: ['BRANCH_ADMIN'],
      permissions: [],
    } as never);

  beforeAll(async () => {
    db = await TestDatabase.create(
      process.env.DATABASE_URL ?? 'postgresql://school_erp:Niraj1307!@localhost:5432/school_erp',
      { project: 'database' },
    );
    prisma = db.client();
    seed = await seedTenant(prisma, { code: 'ATTTRIG', name: 'Trigger School' });
    keypair = testKeypair();

    const peerFetch: typeof fetch = (async (input: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
      const url = String(input);
      peerCalls.push({
        url,
        assertion: init?.headers?.['x-internal-assertion'],
        body: init?.body ? JSON.parse(init.body) : null,
      });
      if (peerReject) throw new Error('ECONNREFUSED (stub)');
      return { ok: peerStatus < 400, status: peerStatus } as Response;
    }) as typeof fetch;

    app = createAttendanceApp({
      env: { INTERNAL_ASSERTION_PUBLIC_KEY: keypair.publicKey },
      prisma,
      communicationBaseUrl: 'http://communication-stub.test',
      internalAssertionPrivateKey: PEER_PRIVATE,
      fetchImpl: peerFetch,
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.teardown();
  });

  it('/mark fires the scan with a verifiable 30s assertion and drain:true', async () => {
    peerCalls.length = 0;
    peerReject = false;
    peerStatus = 200;

    const today = new Date();
    const date = today.toISOString().slice(0, 10);
    const res = await request(app)
      .post('/attendance/mark')
      .set('x-internal-assertion', asTeacher())
      .send({
        date,
        classId: seed.classId,
        sectionId: seed.sectionId,
        records: [{ studentId: seed.studentId, status: 'ABSENT', remarks: 'not in class' }],
      })
      .expect(200);

    expect(res.body.count).toBe(1);
    // The peer call is fire-and-forget — give the event loop a beat.
    await new Promise((r) => setTimeout(r, 50));

    expect(peerCalls).toHaveLength(1);
    expect(peerCalls[0].url).toBe('http://communication-stub.test/absence-alerts/scan');
    expect(peerCalls[0].body).toEqual({ date, channel: 'WHATSAPP', drain: true });

    // The minted assertion decodes with the peer keypair and names this
    // service as audience with the marker's branch — branch-scoped scan.
    const claims = verifyAssertion(peerCalls[0].assertion!, PEER_PUBLIC, 'communication-service');
    expect(claims.branchId).toBe(seed.branchId);
    expect(claims.userId).toBe(seed.adminUserId);
  });

  it('a peer failure never fails marking (fire-and-forget)', async () => {
    peerCalls.length = 0;
    peerReject = true;

    const res = await request(app)
      .post('/attendance/mark')
      .set('x-internal-assertion', asTeacher())
      .send({
        date: new Date().toISOString().slice(0, 10),
        classId: seed.classId,
        sectionId: seed.sectionId,
        records: [{ studentId: seed.studentId, status: 'PRESENT' }],
      })
      .expect(200); // marking succeeded despite ECONNREFUSED

    expect(res.body.count).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(peerCalls).toHaveLength(1); // it tried, it failed, nobody cared
  });

  it('without the private key the call is skipped entirely (leaf-service mode)', async () => {
    const quietApp = createAttendanceApp({
      env: { INTERNAL_ASSERTION_PUBLIC_KEY: keypair.publicKey },
      prisma,
      // no internalAssertionPrivateKey — ADR-3 leaf service
      fetchImpl: (async (input: unknown) => {
        peerCalls.push({ url: String(input), assertion: undefined, body: null });
        return { ok: true, status: 200 } as Response;
      }) as typeof fetch,
    });

    peerCalls.length = 0;
    await request(quietApp)
      .post('/attendance/mark')
      .set('x-internal-assertion', asTeacher())
      .send({
        date: new Date().toISOString().slice(0, 10),
        classId: seed.classId,
        sectionId: seed.sectionId,
        records: [{ studentId: seed.studentId, status: 'ABSENT' }],
      })
      .expect(200);

    await new Promise((r) => setTimeout(r, 50));
    expect(peerCalls).toHaveLength(0);
    // And the marking still wrote its rows.
    const recs = await prisma.attendanceRecord.count({ where: { studentId: seed.studentId, status: 'ABSENT' } });
    expect(recs).toBeGreaterThanOrEqual(1);
  });

  it('mintAssertion from this module round-trips against the auth verifier (sanity)', () => {
    const token = mintAssertion(
      { userId: 'u1', email: 'engine@attendance-service.internal', tenantId: 't1', branchId: 'b1', roles: ['SYSTEM'], audience: 'communication-service' },
      { privateKey: PEER_PRIVATE, ttlSeconds: 30 },
    );
    const claims = verifyAssertion(token, PEER_PUBLIC, 'communication-service');
    expect(claims.userId).toBe('u1');
  });
});
