// ──────────────────────────────────────────────
// Number sequences (BUILD_PLAN 2.3.1)
//
// `nextSequenceValue` is transactional (row lock via SELECT … FOR UPDATE),
// gap-tolerant (a failed transaction never decrements) and per-branch. The
// per-branch `format` string can use the tokens:
//   {SEQ}   zero-padded current value (padding)
//   {YYYY}  current calendar year
//   {YY}    two-digit year
//   {AY}    academic-year label, e.g. "2026-27"
//   {CODE}  the sequence code
// Default format when none is configured: "{CODE}-{SEQ}".
// ──────────────────────────────────────────────

import type { PrismaClient } from '@school-erp/database';

/**
 * A Prisma transaction (interaction) client — structurally the subset of
 * PrismaClient these helpers need. Lets engines already inside a $transaction
 * reuse the sequence logic without nesting a second transaction.
 */
export type TxClient = Pick<PrismaClient, '$queryRaw' | 'sequence' | 'academicYear'>;

export type SequenceCode =
  | 'ADMISSION'
  | 'RECEIPT'
  | 'INVOICE'
  | 'TC'
  | 'EMPLOYEE'
  | 'BONAFIDE'
  | (string & {});

export interface NextSequenceInput {
  branchId: string;
  code: SequenceCode;
  /** Override the stored per-branch format for this call (optional). */
  format?: string | null;
  /** Override the zero-padding for this call (optional). */
  padding?: number;
  /** Test seam: the instant the value is issued. Defaults to now. */
  at?: Date;
}

export interface SequenceRow {
  id: string;
  format: string | null;
  currentValue: number;
  padding: number;
}

/**
 * Render a sequence value. Exported for previews and tests.
 *
 * `ayLabel` is the branch's current academic-year label (e.g. "2025-26"); the
 * {AY} token prefers it and only falls back to deriving from `now` when no
 * current year exists. The academic year, not the wall clock, is the source
 * of truth for school numbering.
 */
export function formatSequence(
  format: string | null,
  code: string,
  value: number,
  padding: number,
  now = new Date(),
  ayLabel?: string | null,
): string {
  const fmt = format ?? `{CODE}-{SEQ}`;
  const year = now.getFullYear();
  // The Indian academic year starts in April.
  const ayStart = now.getMonth() >= 3 ? year : year - 1;
  const ay = ayLabel ?? `${ayStart}-${String(ayStart + 1).slice(2)}`;
  return fmt
    .replaceAll('{SEQ}', String(value).padStart(padding, '0'))
    .replaceAll('{YYYY}', String(year))
    .replaceAll('{YY}', String(year).slice(2))
    .replaceAll('{AY}', ay)
    .replaceAll('{CODE}', code);
}

async function currentAcademicYearLabel(tx: TxClient, branchId: string): Promise<string | null> {
  const ay = await tx.academicYear.findFirst({
    where: { branchId, isCurrent: true },
    select: { name: true },
  });
  return ay?.name ?? null;
}

/**
 * Issue the next value for a branch+code sequence. Runs in its own
 * transaction (the row is locked with FOR UPDATE so two concurrent calls
 * cannot issue the same number; the value only advances when it commits).
 * Already inside a transaction? Call `nextSequenceValueIn` with the tx client.
 */
export async function nextSequenceValue(
  prisma: PrismaClient,
  input: NextSequenceInput,
): Promise<string> {
  return prisma.$transaction((tx) => nextSequenceValueIn(tx as unknown as TxClient, input));
}

/**
 * Transactional core — must be called with a transaction client. Gap-tolerant:
 * a rolled-back transaction never consumes a value.
 */
export async function nextSequenceValueIn(
  tx: TxClient,
  input: NextSequenceInput,
): Promise<string> {
  const { branchId, code } = input;
  const now = input.at ?? new Date();

  const rows = await tx.$queryRaw<SequenceRow[]>`
    SELECT id, format, "currentValue", padding
    FROM "sequences"
    WHERE "branchId" = ${branchId} AND code = ${code}
    FOR UPDATE`;
  let row = rows[0];

  if (!row) {
    const created = await tx.sequence.create({
      data: { branchId, code, format: input.format ?? null, padding: input.padding ?? 5 },
    });
    row = { id: created.id, format: created.format, currentValue: created.currentValue, padding: created.padding };
  }

  const next = row.currentValue + 1;
  const padding = input.padding ?? row.padding;
  const format = input.format !== undefined ? input.format : row.format;

  await tx.sequence.update({
    where: { id: row.id },
    data: { currentValue: next, padding, format, updatedAt: now },
  });

  const ayLabel = await currentAcademicYearLabel(tx, branchId);
  return formatSequence(format, code, next, padding, now, ayLabel);
}

/**
 * Peek at the next value without consuming it (used by promotion previews).
 */
export async function peekSequenceValue(
  prisma: PrismaClient,
  input: NextSequenceInput,
): Promise<string> {
  const row = await prisma.sequence.findUnique({
    where: { branchId_code: { branchId: input.branchId, code: input.code } },
  });
  const padding = input.padding ?? row?.padding ?? 5;
  const format = input.format !== undefined ? input.format : row?.format ?? null;
  const ayLabel = await currentAcademicYearLabel(prisma as unknown as TxClient, input.branchId);
  return formatSequence(format, input.code, (row?.currentValue ?? 0) + 1, padding, input.at ?? new Date(), ayLabel);
}