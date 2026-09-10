// ──────────────────────────────────────────────
// Fee engine unit tests (GATE 3: ≥60% coverage on fee logic)
//
// The fee module is "the module that decides whether you get paid" — these
// tests pin the accountant-trust invariants: deterministic allocation,
// idempotent payments, concession math, and ledger tie-out.
// ──────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@school-erp/database';
import { TestDatabase, seedTenant } from '@school-erp/testing';
import {
  postDemand,
  postPayment,
  ledgerBalance,
  reconcileStudent,
  tieOut,
} from './fees';

describe('fee engine', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let studentA: string;
  let studentB: string;
  let headTuition: string;
  let headTransport: string;

  beforeAll(async () => {
    db = await TestDatabase.create(process.env.DATABASE_URL as string);
    prisma = db.client();
    seed = await seedTenant(prisma, { code: 'FEET', name: 'Fee Test School' });

    // Two students in the seeded class/section.
    const makeStudent = async (admissionNo: string) => {
      const user = await prisma.user.create({
        data: {
          email: `${admissionNo.toLowerCase()}@fee.test`,
          passwordHash: 'x',
          defaultBranchId: seed.branchId,
          roleAssignments: { create: { roleId: 'sys_student', branchId: seed.branchId } },
        },
        select: { id: true },
      });
      return prisma.student.create({
        data: {
          userId: user.id,
          branchId: seed.branchId,
          admissionNo,
          firstName: 'Fee', lastName: admissionNo,
          dateOfBirth: new Date('2013-01-01'),
          gender: 'MALE',
          address: 'x',
          admissionDate: new Date('2026-04-01'),
        },
        select: { id: true },
      });
    };
    studentA = (await makeStudent('FEE-001')).id;
    studentB = (await makeStudent('FEE-002')).id;

    headTuition = (await prisma.feeHead.create({
      data: { code: 'TUIT', name: 'Tuition', branchId: seed.branchId, type: 'TUITION' },
    })).id;
    headTransport = (await prisma.feeHead.create({
      data: { code: 'TRANS', name: 'Transport', branchId: seed.branchId, type: 'TRANSPORT' },
    })).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.teardown();
  });

  it('postDemand creates invoice + lines + DEMAND ledger entries that sum to the total', async () => {
    const invoice = await postDemand(prisma, {
      branchId: seed.branchId,
      studentId: studentA,
      academicYearId: seed.academicYearId,
      lines: [
        { feeHeadId: headTuition, amount: 12000 },
        { feeHeadId: headTransport, amount: 3000 },
      ],
      dueDate: new Date('2026-04-30'),
    });

    expect(invoice.totalAmount.toString()).toBe('15000');
    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId: invoice.id } });
    expect(lines).toHaveLength(2);

    const ledger = await prisma.feeLedger.findMany({ where: { invoiceId: invoice.id } });
    const demandSum = ledger.reduce((s, e) => s + Number(e.amount), 0);
    expect(demandSum).toBe(15000);
  });

  it('postDemand with a discounted line books the CONCESSION-style discount', async () => {
    const invoice = await postDemand(prisma, {
      branchId: seed.branchId,
      studentId: studentA,
      academicYearId: seed.academicYearId,
      lines: [{ feeHeadId: headTuition, amount: 5000, discount: 1000 }],
      dueDate: new Date('2026-04-30'),
    });
    expect(invoice.totalAmount.toString()).toBe('4000');
    expect(invoice.discountAmount.toString()).toBe('1000');

    const ledger = await prisma.feeLedger.findMany({ where: { invoiceId: invoice.id } });
    expect(ledger.reduce((s, e) => s + Number(e.amount), 0)).toBe(4000);
  });

  it('allocates oldest-due-first across two invoices', async () => {
    // Invoice 1 due earlier: ₹10,000. Invoice 2 due later: ₹5,000.
    const inv1 = await postDemand(prisma, {
      branchId: seed.branchId,
      studentId: studentB,
      academicYearId: seed.academicYearId,
      lines: [{ feeHeadId: headTuition, amount: 10000 }],
      dueDate: new Date('2026-04-01'),
    });
    const inv2 = await postDemand(prisma, {
      branchId: seed.branchId,
      studentId: studentB,
      academicYearId: seed.academicYearId,
      lines: [{ feeHeadId: headTransport, amount: 5000 }],
      dueDate: new Date('2026-09-01'),
    });

    // ₹7,000 payment → 7,000 to inv1, 0 to inv2.
    const result = await postPayment(prisma, {
      branchId: seed.branchId,
      studentId: studentB,
      academicYearId: seed.academicYearId,
      amount: 7000,
      method: 'CASH',
    });
    expect(result.duplicate).toBe(false);
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0].invoiceId).toBe(inv1.id);
    expect(result.allocations[0].amount).toBe(7000);

    const afterFirst = await prisma.invoice.findUnique({ where: { id: inv1.id } });
    expect(Number(afterFirst!.paidAmount)).toBe(7000);
    expect(afterFirst!.status).toBe('PARTIALLY_PAID');

    // ₹9,000 more → 3,000 clears inv1, 6,000 of inv2's 5,000 → 5,000 + advance.
    const second = await postPayment(prisma, {
      branchId: seed.branchId,
      studentId: studentB,
      academicYearId: seed.academicYearId,
      amount: 9000,
      method: 'CASH',
    });
    const inv1After = await prisma.invoice.findUnique({ where: { id: inv1.id } });
    expect(inv1After!.status).toBe('PAID');

    const inv2After = await prisma.invoice.findUnique({ where: { id: inv2.id } });
    // ₹5,000 dues + the ₹1,000 advance booked on the same (last) invoice —
    // paidAmount may legitimately exceed totalAmount for an advance.
    expect(Number(inv2After!.paidAmount)).toBe(6000);
    expect(inv2After!.status).toBe('PAID');
    const advanceAlloc = second.allocations.find((a) => a.invoiceId === inv2.id);
    expect(advanceAlloc).toBeTruthy();
    expect(advanceAlloc!.amount).toBe(6000);
    void result;
  });

  it('is idempotent: the same key returns the original payment and never double-credits', async () => {
    const key = 'idem-fee-test-001';
    const first = await postPayment(prisma, {
      branchId: seed.branchId,
      studentId: studentA,
      academicYearId: seed.academicYearId,
      amount: 2500,
      method: 'UPI',
      idempotencyKey: key,
    });
    expect(first.duplicate).toBe(false);

    const replay = await postPayment(prisma, {
      branchId: seed.branchId,
      studentId: studentA,
      academicYearId: seed.academicYearId,
      amount: 2500,
      method: 'UPI',
      idempotencyKey: key,
    });
    expect(replay.duplicate).toBe(true);
    expect(replay.payment.id).toBe(first.payment.id);

    // Exactly one PAYMENT ledger entry for that amount.
    const entries = await prisma.feeLedger.findMany({
      where: { studentId: studentA, type: 'PAYMENT' },
    });
    const matching = entries.filter((e) => Number(e.amount) === -2500);
    expect(matching).toHaveLength(1);
  });

  it('partial payments allocate deterministically on repeat', async () => {
    // A hermetic student so earlier tests' allocations cannot interfere.
    const user = await prisma.user.create({
      data: {
        email: 'fee-003@fee.test',
        passwordHash: 'x',
        defaultBranchId: seed.branchId,
        roleAssignments: { create: { roleId: 'sys_student', branchId: seed.branchId } },
      },
      select: { id: true },
    });
    const studentC = (await prisma.student.create({
      data: {
        userId: user.id,
        branchId: seed.branchId,
        admissionNo: 'FEE-003',
        firstName: 'Fee', lastName: 'C',
        dateOfBirth: new Date('2013-01-01'),
        gender: 'MALE',
        address: 'x',
        admissionDate: new Date('2026-04-01'),
      },
      select: { id: true },
    })).id;

    const invoice = await postDemand(prisma, {
      branchId: seed.branchId,
      studentId: studentC,
      academicYearId: seed.academicYearId,
      lines: [{ feeHeadId: headTuition, amount: 6000 }],
      dueDate: new Date('2026-05-31'),
    });
    await postPayment(prisma, {
      branchId: seed.branchId,
      studentId: studentC,
      academicYearId: seed.academicYearId,
      amount: 1500,
      method: 'CASH',
    });
    await postPayment(prisma, {
      branchId: seed.branchId,
      studentId: studentC,
      academicYearId: seed.academicYearId,
      amount: 1500,
      method: 'CASH',
    });

    // Total paid = 3,000, status PARTIALLY_PAID — deterministic across runs.
    const after = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(Number(after!.paidAmount)).toBe(3000);
    expect(after!.status).toBe('PARTIALLY_PAID');
  });

  it('ledgerBalance and reconcileStudent agree, and tieOut finds no mismatches', async () => {
    for (const studentId of [studentA, studentB]) {
      const balance = await ledgerBalance(prisma, { studentId, academicYearId: seed.academicYearId });
      const recon = await reconcileStudent(prisma, { studentId, academicYearId: seed.academicYearId });
      // Ledger view and invoice view must agree exactly — the accountant's
      // trust invariant.
      expect(recon.ledgerBalance).toBe(balance);
      expect(recon.difference).toBe(0);
    }
    const mismatches = await tieOut(prisma, {
      branchId: seed.branchId,
      academicYearId: seed.academicYearId,
    });
    if (mismatches.length) console.log('tie-out mismatches:', mismatches);
    expect(mismatches.length).toBe(0);
  });
});
