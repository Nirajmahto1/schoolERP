// ──────────────────────────────────────────────
// Platform admin authentication (BUILD_PLAN 1.7)
//
// Platform admins are NOT tenant users: they live in the control plane's
// `platform_admins` table and their session cookie is signed with a dedicated
// secret. This is the console that can suspend a school or request a support
// grant — it must never share an identity provider with school staff, and its
// routes must never be reachable on a tenant subdomain.
// ──────────────────────────────────────────────

import { createHmac, timingSafeEqual } from 'crypto';
import { cookies } from 'next/headers';
import { PrismaClient } from '@school-erp/control-plane';

declare global {
  // eslint-disable-next-line no-var
  var __adminConsoleControlPlane: PrismaClient | undefined;
}

/** One control-plane client per process (Next.js hot reloads modules). */
export function controlPlane(): PrismaClient {
  if (!globalThis.__adminConsoleControlPlane) {
    const url = process.env.CONTROL_PLANE_DATABASE_URL;
    if (!url) {
      throw new Error('CONTROL_PLANE_DATABASE_URL is required for the admin console.');
    }
    globalThis.__adminConsoleControlPlane = new PrismaClient({ datasourceUrl: url });
  }
  return globalThis.__adminConsoleControlPlane;
}

const COOKIE_NAME = 'admin_session';
const SESSION_TTL_SECONDS = 8 * 3600; // an admin console session is a workday

function sessionSecret(): string {
  const secret = process.env.ADMIN_CONSOLE_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'ADMIN_CONSOLE_SESSION_SECRET must be set (>= 32 chars). Generate with: openssl rand -base64 48',
    );
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

/** Create the session cookie after a verified password check. */
export async function createSession(adminId: string): Promise<void> {
  const expires = Date.now() + SESSION_TTL_SECONDS * 1000;
  const payload = `${adminId}.${expires}`;
  const store = await cookies();
  store.set(COOKIE_NAME, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export interface AdminSession {
  adminId: string;
  email: string;
  role: string;
}

/** Verify the session cookie AND re-read the admin from the database. */
export async function currentAdmin(): Promise<AdminSession | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) return null;

  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [adminId, expires, signature] = parts;

  const expected = sign(`${adminId}.${expires}`);
  const a = Buffer.from(signature, 'base64url');
  const b = Buffer.from(expected, 'base64url');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(expires) < Date.now()) return null;

  const admin = await controlPlane().platformAdmin.findUnique({
    where: { id: adminId },
    select: { id: true, email: true, role: true, isActive: true },
  });
  if (!admin?.isActive) return null;

  return { adminId: admin.id, email: admin.email, role: admin.role };
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}
