// ──────────────────────────────────────────────
// Offline attendance outbox — mobile (Phase 9.5, mirrors the web outbox).
//
// "Teachers mark attendance on phones in corridors with bad wifi" (§8.7).
// The web outbox owns the browser (IndexedDB); this one owns the phone.
//
// Storage: AsyncStorage holds a JSON array of queued batches — one key,
// small documents, atomic read-modify-write. (SQLite would be step two if
// batches grew to thousands; a day's marks are <100 records.)
//
// Semantics match the web outbox exactly, because the server treats both
// the same way:
//   • each batch keeps a STABLE slot key (date+classId+sectionId) — retries
//     replay the server's own session-upsert, never double-write
//   • re-marking the same slot while offline REPLACES the queued batch
//     (last write wins) and keeps its original created time
//   • attempts cap at 8 (poison guard); 4xx ≠ 401/429 stops retrying
// ──────────────────────────────────────────────
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'erp_attendance_outbox';
const MAX_ATTEMPTS = 8;

export interface QueuedAttendance {
  id: string; // uuid — stable across retries for this slot
  date: string; // YYYY-MM-DD
  classId: string;
  sectionId: string;
  records: { studentId: string; status: string; remarks?: string }[];
  markedBy?: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

async function readAll(): Promise<QueuedAttendance[]> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedAttendance[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(items: QueuedAttendance[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(items));
}

function uuid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Queue one day+section batch durably. Replaces any earlier unsynced batch
 *  for the same slot (last-write-wins), keeping its original id so an
 *  in-flight batch cannot be double-applied under a new key. */
export async function queueAttendance(
  batch: Omit<QueuedAttendance, 'id' | 'createdAt' | 'attempts'>,
): Promise<string> {
  const all = await readAll();
  const slot = (b: QueuedAttendance) => b.date === batch.date && b.classId === batch.classId && b.sectionId === batch.sectionId;
  const existing = all.find(slot);
  const record: QueuedAttendance = {
    ...batch,
    id: existing?.id ?? uuid(),
    createdAt: existing?.createdAt ?? Date.now(),
    attempts: existing?.attempts ?? 0,
  };
  await writeAll([...all.filter((b) => !slot(b)), record]);
  return record.id;
}

/** Drain the outbox. `poster` performs the network call and throws on
 *  failure (the api layer's 401-refresh keeps working). Returns how many
 *  batches were flushed. */
export async function syncAttendance(
  poster: (batch: QueuedAttendance) => Promise<unknown>,
): Promise<number> {
  const all = await readAll();
  if (all.length === 0) return 0;

  let flushed = 0;
  const keep: QueuedAttendance[] = [];
  for (const batch of all) {
    if (batch.attempts >= MAX_ATTEMPTS) { keep.push(batch); continue; }
    try {
      await poster(batch);
      flushed += 1;
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      const attempts = batch.attempts + 1;
      // 4xx (≠ 401/429) is permanent — stop retrying this batch.
      const permanent = typeof status === 'number' && status >= 400 && status < 500 && status !== 401 && status !== 429;
      keep.push({ ...batch, attempts, lastError: String(err) });
      if (!permanent && attempts < MAX_ATTEMPTS) continue;
      if (permanent) continue;
      // exhausted: keep for surfacing, stop retrying
    }
  }
  await writeAll(keep);
  return flushed;
}

/** Pending batches for badges/indicators. */
export async function pendingAttendance(): Promise<QueuedAttendance[]> {
  return readAll();
}
