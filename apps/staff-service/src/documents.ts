// ──────────────────────────────────────────────
// Identity-document storage (staff Aadhaar/ID proofs)
//
// Threat model for KYC documents — the strictest class of file we handle:
//   • Content is untrusted: the declared MIME type is client-supplied, so the
//     magic bytes decide (PDF %PDF-, JPEG FF D8 FF, PNG signature). A renamed
//     .exe or .html never reaches disk.
//   • Filenames are server-generated (doc_<ts>_<hex>.<ext>) — path traversal
//     and collisions are impossible by construction; downloads allowlist the
//     name format again before touching the filesystem.
//   • Integrity is recorded: SHA-256 checksum at write time lets an auditor
//     prove the stored bytes are the bytes that were uploaded.
//   • Stored under <cwd>/data/documents — outside any web-served directory;
//     download goes through an authenticated, access-logged route only.
//   • KYC size cap: 5 MB. Scans of one ID page fit comfortably.
// The storage-root seam (setDocumentStorageDir) keeps tests hermetic and
// makes an S3/MinIO swap a one-function change later.
// ──────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Request } from 'express';

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024; // 5 MB

/** Multer gate: size + count only. Content sniffing happens after the buffer
 *  lands (memory storage) so a lying declared type never reaches disk. */
export const multerLimits = {
  fileSize: MAX_DOCUMENT_BYTES,
  files: 1,
};

export type SniffedKind = 'pdf' | 'jpg' | 'png';

/** Magic-byte sniff — the ONLY source of truth for what a file really is. */
export function sniffKind(buf: Buffer): SniffedKind | null {
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return 'png';
  return null;
}

export function extFor(kind: SniffedKind): string {
  return kind === 'pdf' ? 'pdf' : kind === 'jpg' ? 'jpg' : 'png';
}

let storageDirOverride: string | null = null;
export function setDocumentStorageDir(dir: string | null): void {
  storageDirOverride = dir;
}
export function documentStorageDir(): string {
  return storageDirOverride ?? path.resolve(process.cwd(), 'data', 'documents');
}

export class DocumentError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** Persist one uploaded buffer. Returns everything the DB row needs. */
export async function saveDocument(buf: Buffer): Promise<{ url: string; checksum: string; mimeType: string; sizeBytes: number }> {
  const kind = sniffKind(buf);
  if (!kind) {
    throw new DocumentError(415, 'document-type-unsupported', 'Only PDF, JPG or PNG files are accepted.');
  }
  const name = `doc_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${extFor(kind)}`;
  const dir = documentStorageDir();
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, name), buf);
  return {
    url: `/documents/file/${name}`,
    checksum: crypto.createHash('sha256').update(buf).digest('hex'),
    mimeType: kind === 'pdf' ? 'application/pdf' : kind === 'jpg' ? 'image/jpeg' : 'image/png',
    sizeBytes: buf.length,
  };
}

export async function deleteDocumentByUrl(url: string): Promise<void> {
  const name = path.basename(url);
  await fs.promises.unlink(path.join(documentStorageDir(), name)).catch(() => undefined);
}

/** Read a stored document back. The name format is allowlisted before any
 *  path is built, so traversal input dies here. */
export async function readDocumentByName(name: string): Promise<Buffer> {
  if (!/^doc_[0-9]+_[a-f0-9]{16}\.(pdf|jpg|png)$/.test(name)) {
    throw new DocumentError(400, 'invalid-document-name', 'Invalid document filename.');
  }
  try {
    return await fs.promises.readFile(path.join(documentStorageDir(), name));
  } catch {
    throw new DocumentError(404, 'document-not-found', 'No such document.');
  }
}

/** Documents live in a local dir — reflect the actual dir on requests so ops
 *  can verify where KYC data physically sits. */
export function storageLocation(req: Request): string {
  return documentStorageDir();
}
