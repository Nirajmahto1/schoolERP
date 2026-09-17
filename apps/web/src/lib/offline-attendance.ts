// ──────────────────────────────────────────────
// Offline attendance outbox (Phase 8.7 / GATE 8.2)
//
// "Teachers mark attendance on phones in corridors with bad wifi."
//
// Design:
//   • Marks are written to IndexedDB FIRST, then a background attempt POSTs
//     them. Airplane mode costs nothing — the record is already durable.
//   • Idempotency: each batch carries a client-generated UUID (clientBatchId).
//     Retries reuse the SAME id, so a flaky connection that "succeeds" after
//     the UI gave up cannot double-write: the server upserts the same
//     (date, class, section) session the batch names.
//   • Conflict policy: LAST WRITE WINS per student. Repeated offline marking
//     of the same day+section overwrites the queued record — the newest tap
//     is what the teacher intended. This matches how the server's upsert
//     behaves for a session re-marked the same day.
//   • Sync triggers: visibility change, online event, and an interval while
//     the attendance page is mounted. Failures leave the item queued with an
//     attempt counter (give up permanently at 8 tries to avoid poison rows).
// ──────────────────────────────────────────────

'use client';

const DB_NAME = 'educore-outbox';
const DB_VERSION = 1;
const STORE = 'attendance';

export interface QueuedAttendance {
  id: string; // uuid — the idempotency key (clientBatchId)
  date: string; // YYYY-MM-DD
  classId: string;
  sectionId: string;
  records: { studentId: string; status: string; remarks?: string }[];
  markedBy?: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('bySlot', ['date', 'classId', 'sectionId']);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (crypto as any).getRandomValues(new Uint8Array(16)).join('');
}

/** Queue one day+section batch durably. Replaces any earlier unsynced batch
 *  for the same slot (last-write-wins) but KEEPS its original id so a batch
 *  already in flight cannot be double-applied with a new key. */
export async function queueAttendance(
  batch: Omit<QueuedAttendance, 'id' | 'createdAt' | 'attempts'>,
): Promise<string> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const idx = store.index('bySlot');
    const find = idx.get([batch.date, batch.classId, batch.sectionId]);
    find.onsuccess = () => {
      const existing = find.result as QueuedAttendance | undefined;
      const record: QueuedAttendance = {
        ...batch,
        id: existing?.id ?? uuid(),
        createdAt: existing?.createdAt ?? Date.now(),
        attempts: existing?.attempts ?? 0,
      };
      const put = store.put(record);
      put.onsuccess = () => resolve(record.id);
      put.onerror = () => reject(put.error);
    };
    find.onerror = () => reject(find.error);
  });
}

/** Drain the outbox. `poster` performs the network call and throws on
 *  failure — the API layer's 401-refresh logic keeps working offline-first.
 *  Returns how many batches were flushed. */
export async function syncAttendance(
  poster: (batch: QueuedAttendance) => Promise<unknown>,
): Promise<number> {
  if (typeof window === 'undefined' || !navigator.onLine) return 0;
  const db = await openDb();
  const all = await new Promise<QueuedAttendance[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as QueuedAttendance[]);
    req.onerror = () => reject(req.error);
  });
  if (all.length === 0) return 0;

  let flushed = 0;
  for (const batch of all) {
    if (batch.attempts >= 8) continue; // poison guard; surfaced in UI
    try {
      await poster(batch);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const del = tx.objectStore(STORE).delete(batch.id);
        del.onsuccess = () => resolve();
        del.onerror = () => reject(del.error);
      });
      flushed += 1;
    } catch (err: unknown) {
      // Only network-ish failures stay queued; 4xx validation errors are
      // permanent — record the error but stop retrying this batch.
      const status = (err as { status?: number })?.status;
      const attempts = batch.attempts + 1;
      const permanent = typeof status === 'number' && status >= 400 && status < 500 && status !== 401 && status !== 429;
      if (permanent || attempts >= 8) {
        await new Promise<void>((resolve) => {
          const tx = db.transaction(STORE, 'readwrite');
          const put = tx.objectStore(STORE).put({ ...batch, attempts, lastError: String(err) });
          put.onsuccess = () => resolve();
          put.onerror = () => resolve();
        });
        if (permanent) continue;
      } else {
        await new Promise<void>((resolve) => {
          const tx = db.transaction(STORE, 'readwrite');
          const put = tx.objectStore(STORE).put({ ...batch, attempts, lastError: String(err) });
          put.onsuccess = () => resolve();
          put.onerror = () => resolve();
        });
      }
    }
  }
  return flushed;
}

/** Count + list pending batches for UI badges. */
export async function pendingAttendance(): Promise<QueuedAttendance[]> {
  if (typeof window === 'undefined') return [];
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as QueuedAttendance[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}
