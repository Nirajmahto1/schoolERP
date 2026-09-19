// ──────────────────────────────────────────────
// Profile-photo storage (staff + students).
//
// Mirrors documents.ts deliberately: bytes are sniffed (never trusted by
// extension), written to a local dir under the deployment root, and served
// back through an authenticated route whose filename is allowlisted before
// any path is built. Photos are JPG/PNG only and capped at 5 MB.
// ──────────────────────────────────────────────

import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { Request } from 'express';

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export type PhotoKind = 'jpg' | 'png';

/** Magic-byte sniffing — a .jpg named .png dies here. */
export function sniffPhotoKind(buf: Buffer): PhotoKind | null {
  if (buf.length < 8) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'png';
  }
  return null;
}

function extFor(kind: PhotoKind): string {
  return kind === 'jpg' ? 'jpg' : 'png';
}

/** Storage root override for tests; production uses <cwd>/data/photos. */
let photosDirOverride: string | null = null;
export function setPhotosDirOverride(dir: string | null): void {
  photosDirOverride = dir;
}
export function photosStorageDir(): string {
  return photosDirOverride ?? path.resolve(process.cwd(), 'data', 'photos');
}

export class PhotoError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** Persist one uploaded photo buffer. Returns the URL the DB row stores. */
export async function savePhoto(buf: Buffer): Promise<{ url: string; mimeType: string; sizeBytes: number; checksum: string }> {
  const kind = sniffPhotoKind(buf);
  if (!kind) {
    throw new PhotoError(415, 'photo-type-unsupported', 'Only JPG or PNG photos are accepted.');
  }
  const name = `photo_${Date.now()}_${randomBytes(8).toString('hex')}.${extFor(kind)}`;
  const dir = photosStorageDir();
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, name), buf);
  return {
    url: `/photos/file/${name}`,
    mimeType: kind === 'jpg' ? 'image/jpeg' : 'image/png',
    sizeBytes: buf.length,
    checksum: createHash('sha256').update(buf).digest('hex'),
  };
}

export async function deletePhotoByUrl(url: string | null | undefined): Promise<void> {
  if (!url || !url.startsWith('/photos/file/')) return;
  const name = path.basename(url);
  await fs.promises.unlink(path.join(photosStorageDir(), name)).catch(() => undefined);
}

/** Read a stored photo back. Name format is allowlisted before any path is
 *  built, so traversal input dies here. */
export async function readPhotoByName(name: string): Promise<{ buf: Buffer; mimeType: string }> {
  if (!/^photo_[0-9]+_[a-f0-9]{16}\.(jpg|png)$/.test(name)) {
    throw new PhotoError(400, 'invalid-photo-name', 'Invalid photo filename.');
  }
  try {
    const buf = await fs.promises.readFile(path.join(photosStorageDir(), name));
    return { buf, mimeType: name.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  } catch {
    throw new PhotoError(404, 'photo-not-found', 'No such photo.');
  }
}

/** Where the photos physically sit — surfaced on responses so ops can verify. */
export function photosLocation(_req: Request): string {
  return photosStorageDir();
}
