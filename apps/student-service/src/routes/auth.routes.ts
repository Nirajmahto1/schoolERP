// ──────────────────────────────────────────────
// Auth Routes — login, refresh, logout, me
//
// REMOVED: POST /auth/register.
// It was mounted publicly and its schema accepted `role: 'SUPER_ADMIN'` with an
// attacker-chosen branchId/schoolId, so anyone on the internet could mint a
// super-admin for any school. User creation is invite-only and lives behind
// authentication (Phase 1 provisioning + Phase 3 identity-service).
//
// Phase 1 tenancy: with one database per school, the login request must first
// be routed to the right database. The client says which school it is reaching
// via `X-Tenant-Slug` (subdomain requests are normalized to the same header by
// the gateway). The service consults the control-plane `user_directory` (an
// email-hash → tenant index, never the address) to resolve or verify the
// tenant before opening the user's database.
// ──────────────────────────────────────────────

import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { PrismaClient } from '@school-erp/database';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import type { IdentityEnv } from '@school-erp/config';
import {
  MemoryTokenStore,
  TokenError,
  issueTokenPair,
  revokeSession,
  rotateRefreshToken,
  type LiveUser,
  type TokenConfig,
  type TokenStore,
} from '@school-erp/auth';
import { findUserTenant, indexTenantUser } from '@school-erp/tenant';
import { logger } from '../utils/logger';

const router = Router();

// Single process-wide store. Swap for RedisTokenStore behind a load balancer —
// an in-memory denylist across instances silently fails to revoke.
const store: TokenStore = new MemoryTokenStore();

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

function problem(
  res: Response,
  status: number,
  type: string,
  title: string,
  detail: string,
): void {
  res.status(status).type('application/problem+json').json({ type, title, status, detail });
}

function tokenConfig(env: IdentityEnv): TokenConfig {
  return {
    accessSecret: env.JWT_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessExpiresIn: env.JWT_EXPIRES_IN,
    refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
  };
}

/** The control-plane client every route shares (set on the app in app.ts). */
function controlPlane(req: Request): ControlPlaneClient | null {
  return (req.app.get('controlPlane') as ControlPlaneClient | undefined) ?? null;
}

/**
 * Load the authoritative user record.
 *
 * Roles come from the DB on every login *and* every refresh. Until Phase 2.1
 * introduces the Role tables, `User.role` is the single source; the array shape
 * here is what the rest of the system already expects.
 */
async function loadUser(prisma: PrismaClient, userId: string): Promise<LiveUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      isActive: true,
      role: true,
      branchId: true,
      schoolId: true,
    },
  });
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    isActive: user.isActive,
    tenantId: user.schoolId,
    schoolId: user.schoolId,
    branchId: user.branchId,
    roles: [user.role],
  };
}

/**
 * Resolve the tenant database for a login.
 *
 * Priority:
 *   1. `X-Tenant-Slug` — which school the client is reaching (subdomain via
 *      the gateway, or the mobile header). Resolved against the control plane.
 *   2. `user_directory` — where this email lives. Repairs routing when the
 *      client is a browser on the apex domain with no slug available.
 *
 * The two must agree. A mismatch (credentials of school A aimed at school B)
 * is refused before any password work happens.
 */
async function resolveLoginTenant(
  req: Request,
  email: string,
): Promise<{ prisma: PrismaClient; tenantId: string } | { error: [number, string, string, string] }> {
  const cp = controlPlane(req);
  const prismaDefault = req.app.get('prisma') as PrismaClient | undefined;
  if (!cp || !prismaDefault) {
    // No control plane wired (older deployments/tests): single-database mode.
    return { prisma: prismaDefault as PrismaClient, tenantId: '' };
  }

  const slugHeader = req.header('x-tenant-slug')?.toLowerCase();
  const directory = await findUserTenant(cp, email);

  let prisma: PrismaClient | null = null;
  let tenantId = '';

  if (slugHeader) {
    const record = await cp.tenant.findUnique({
      where: { slug: slugHeader },
      include: { datastore: true },
    });
    if (!record) {
      return { error: [404, 'tenant-not-found', 'Unknown School', 'No school matches this address.'] };
    }
    if (!record.datastore) {
      return { error: [503, 'tenant-unavailable', 'School Not Ready', 'This school is still being provisioned. Try again shortly.'] };
    }
    prisma = new PrismaClient({ datasourceUrl: record.datastore.connRef });
    tenantId = record.id;

    if (directory && directory.tenantId !== tenantId) {
      // Credentials of school A aimed at school B: refuse before any password
      // work. Same generic message as a bad password — never confirm which
      // emails exist in which school.
      return { error: [401, 'authentication-error', 'Invalid Credentials', 'Email or password is incorrect.'] };
    }
  } else if (directory) {
    const record = await cp.tenant.findUnique({
      where: { id: directory.tenantId },
      include: { datastore: true },
    });
    if (record?.datastore) {
      prisma = new PrismaClient({ datasourceUrl: record.datastore.connRef });
      tenantId = record.id;
    }
  }

  if (!prisma) {
    // No hint and no directory entry: fall back to the ambient DATABASE_URL
    // (the dev / single-tenant deployment shape).
    return { prisma: prismaDefault, tenantId: '' };
  }
  return { prisma, tenantId };
}

// ── POST /auth/login ──
router.post('/login', async (req: Request, res: Response) => {
  const env: IdentityEnv = req.app.get('env');

  let credentials: z.infer<typeof loginSchema>;
  try {
    credentials = loginSchema.parse(req.body);
  } catch {
    // Deliberately does not echo which field failed — an attacker learns
    // nothing about valid email formats in this tenant.
    problem(res, 400, 'validation-error', 'Invalid Input', 'Email and password are required.');
    return;
  }

  try {
    const routed = await resolveLoginTenant(req, credentials.email);
    if ('error' in routed) {
      problem(res, ...routed.error);
      return;
    }
    const { prisma } = routed;

    const record = await prisma.user.findUnique({
      where: { email: credentials.email.toLowerCase() },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        isActive: true,
        role: true,
        branchId: true,
        schoolId: true,
      },
    });

    // Constant-ish work whether or not the user exists, so response timing does
    // not reveal which emails are registered.
    const hash =
      record?.passwordHash ??
      '$2a$12$0000000000000000000000000000000000000000000000000000';
    const passwordMatches = await bcrypt.compare(credentials.password, hash);

    if (!record || !passwordMatches || !record.isActive) {
      logger.warn(
        `Failed login for ${credentials.email} from ${req.ip} (${
          !record ? 'no such user' : !passwordMatches ? 'bad password' : 'inactive'
        })`,
      );
      problem(
        res,
        401,
        'authentication-error',
        'Invalid Credentials',
        'Email or password is incorrect.',
      );
      return;
    }

    const user: LiveUser = {
      id: record.id,
      email: record.email,
      isActive: record.isActive,
      // Routing key vs write key: `tenantId` names the control-plane tenant
      // (which database); `schoolId` names the School row inside it (what
      // handlers scope by). Equal in dev single-DB mode.
      tenantId: routed.tenantId || record.schoolId,
      schoolId: record.schoolId,
      branchId: record.branchId,
      roles: [record.role],
    };

    // Keep the directory index fresh: a login is the cheapest moment to repair
    // a drifted entry (idempotent upsert on the email hash).
    const cp = controlPlane(req);
    const routedTenantId = routed.tenantId || record.schoolId;
    if (cp) {
      await indexTenantUser(cp, routedTenantId, { id: record.id, email: record.email }).catch(() =>
        undefined,
      );
    }

    const pair = await issueTokenPair(user, tokenConfig(env), store);

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    logger.info(`Login succeeded for ${user.email} (tenant ${user.tenantId})`);

    res.json({
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresIn: pair.expiresIn,
      tokenType: 'Bearer',
      user: {
        id: user.id,
        email: user.email,
        roles: user.roles,
        branchId: user.branchId,
      },
    });
  } catch (error) {
    logger.error(`Login error: ${(error as Error).message}`);
    problem(res, 500, 'internal-error', 'Server Error', 'An unexpected error occurred.');
  }
});

// ── POST /auth/refresh ──
router.post('/refresh', async (req: Request, res: Response) => {
  const prisma: PrismaClient = req.app.get('prisma');
  const env: IdentityEnv = req.app.get('env');

  let body: z.infer<typeof refreshSchema>;
  try {
    body = refreshSchema.parse(req.body);
  } catch {
    problem(res, 400, 'validation-error', 'Missing Token', 'A refresh token is required.');
    return;
  }

  try {
    // Rotates the token and re-reads the user from the database, so a
    // deactivated or role-changed user cannot refresh into stale privileges.
    const pair = await rotateRefreshToken(body.refreshToken, tokenConfig(env), store, (userId) =>
      loadUser(prisma, userId),
    );

    res.json({
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresIn: pair.expiresIn,
      tokenType: 'Bearer',
    });
  } catch (error) {
    if (error instanceof TokenError) {
      if (error.reason === 'reused') {
        // Someone replayed a rotated token. The family is already revoked.
        logger.error(`Refresh token reuse detected from ${req.ip} — family revoked`);
      }
      problem(
        res,
        401,
        'authentication-error',
        'Invalid Refresh Token',
        'Your session is no longer valid. Please sign in again.',
      );
      return;
    }
    logger.error(`Refresh error: ${(error as Error).message}`);
    problem(res, 500, 'internal-error', 'Server Error', 'An unexpected error occurred.');
  }
});

// ── POST /auth/logout ──
// Actually revokes: burns the refresh family and denylists the access token.
router.post('/logout', async (req: Request, res: Response) => {
  const env: IdentityEnv = req.app.get('env');

  const authHeader = req.headers.authorization;
  const accessToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : undefined;
  const refreshToken =
    typeof (req.body as { refreshToken?: unknown } | undefined)?.refreshToken === 'string'
      ? (req.body as { refreshToken: string }).refreshToken
      : undefined;

  await revokeSession(accessToken, refreshToken, tokenConfig(env), store);

  // 204 regardless: logout must be idempotent and must not disclose whether the
  // presented tokens were valid.
  res.status(204).end();
});

export { router as authRoutes, store as tokenStore };
