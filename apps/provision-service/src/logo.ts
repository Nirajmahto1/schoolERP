// ──────────────────────────────────────────────
// Logo storage (first-run wizard)
//
// The school logo is a real upload, not a URL field: a principal dropping in
// a JPG/PNG from the school photographer. Validation is content-based — the
// declared MIME type is client-supplied and untrustworthy, so the file's
// magic bytes decide (JPEG starts FF D8 FF, PNG starts the 8-byte signature
// 89 50 4E 47 0D 0A 1A 0A).
//
// Storage is the local filesystem (data/logos under the deployment root):
// a self-hosted VPS has one app server, and Phase-1's object storage
// (MinIO/S3) is optional infrastructure. The stored filename is server-
// generated — never the client's — which kills path traversal and
// collisions in one move.
// ──────────────────────────────────────────────

import { randomBytes } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import path from 'path';
import multer from 'multer';
import type { Request } from 'express';

/** Accepted image types, by magic bytes. */
const SIGNATURES: Array<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    ext: 'png',
    test: (b) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
];

export const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB — a logo, not an album

export class LogoError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Storage root override for tests; production uses <repo>/data/logos. */
let storageDirOverride: string | null = null;
export function setLogoStorageDir(dir: string | null): void {
  storageDirOverride = dir;
}
export function logoStorageDir(): string {
  return storageDirOverride ?? path.resolve(process.cwd(), 'data', 'logos');
}

/**
 * Multer gate: 2 MB cap, images only by declared type. Content sniffing
 * happens after the buffer lands (multer memory storage) so a lying
 * Content-Type never reaches disk.
 */
export const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_BYTES, files: 1 },
  fileFilter: (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    if (!['image/jpeg', 'image/png'].includes(file.mimetype)) {
      cb(new LogoError(415, 'Logo must be a JPG or PNG image.'));
      return;
    }
    cb(null, true);
  },
});

/**
 * Validate magic bytes, write under a server-generated name, return the
 * public URL path served by GET /setup/logo/:file.
 */
export async function saveLogo(buffer: Buffer): Promise<string> {
  if (buffer.length < 8) {
    throw new LogoError(415, 'Logo file is not a valid image.');
  }
  const match = SIGNATURES.find((sig) => sig.test(buffer));
  if (!match) {
    throw new LogoError(415, 'Logo must be a real JPG or PNG image.');
  }

  const dir = logoStorageDir();
  await mkdir(dir, { recursive: true });
  const name = `logo_${Date.now()}_${randomBytes(8).toString('hex')}.${match.ext}`;
  await writeFile(path.join(dir, name), buffer);
  return `/setup/logo/${name}`;
}

/** Delete a previously stored logo (best-effort cleanup). */
export async function deleteLogoByUrl(url: string | null | undefined): Promise<void> {
  if (!url?.startsWith('/setup/logo/')) return;
  const name = path.basename(url); // basename kills any traversal attempt
  await unlink(path.join(logoStorageDir(), name)).catch(() => undefined);
}
