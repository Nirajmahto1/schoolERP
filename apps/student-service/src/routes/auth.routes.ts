// ──────────────────────────────────────────────
// Auth Routes — login, refresh, logout, me
//
// REMOVED: POST /auth/register.
// It was mounted publicly and its schema accepted `role: 'SUPER_ADMIN'` with an
// attacker-chosen branchId/schoolId, so anyone on the internet could mint a
// super-admin for any school. User creation is invite-only and lives behind
// authentication (Phase 1 provisioning + Phase 3 identity-service).
// ──────────────────────────────────────────────

import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { PrismaClient } from '@school-erp/database';
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
import { logger } from '../utils/logger';

const router = Router();

// Single process-wide store. Phase 1 swaps this for RedisTokenStore so that
// revocation is shared across instances — an in-memory denylist behind a load
// balancer silently fails to revoke on the other instances.
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
    branchId: user.branchId,
    roles: [user.role],
  };
}

// ── POST /auth/login ──
router.post('/login', async (req: Request, res: Response) => {
  const prisma: PrismaClient = req.app.get('prisma');
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
      tenantId: record.schoolId,
      branchId: record.branchId,
      roles: [record.role],
    };

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
