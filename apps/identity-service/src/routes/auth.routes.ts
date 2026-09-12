// ──────────────────────────────────────────────
// Auth Routes — login (+MFA), refresh, logout, me, sessions, permissions
//
// Extracted from student-service (BUILD_PLAN Phase 3.1). Auth living inside
// students was why that file crossed 1,200 lines; identity is its own service
// now.
//
// Everything here is invite-only: there is no public registration. The
// gateway is the only legitimate caller of the public subset (/login,
// /refresh, /logout, /mfa/verify, /password/*) — in deployment the service
// port is network-restricted, and the gateway rate-limits these routes.
//
// MFA: BRANCH_ADMIN / PRINCIPAL / SUPER_ADMIN / FINANCE / ACCOUNTANT roles
// get a TOTP challenge (BUILD_PLAN 2.1.5 + 3.1). Login with `totp` in the
// payload verifies immediately; without it the response is 200 with
// `mfaRequired: true` and a short-lived `mfaToken` that /mfa/verify exchanges
// for the real token pair. Enrollment: POST /mfa/enroll (authenticated) →
// secret + otpauth URL; POST /mfa/activate confirms a valid code and switches
// the account on.
// ──────────────────────────────────────────────

import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { authenticator } from 'otplib';
import { PrismaClient } from '@school-erp/database';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import type { IdentityEnv } from '@school-erp/config';
import {
  MemoryTokenStore,
  TokenError,
  issueTokenPair,
  revokeSession,
  revokeAllSessions,
  rotateRefreshToken,
  type LiveUser,
  type TokenConfig,
  type TokenStore,
} from '@school-erp/auth';
import { findUserTenant, indexTenantUser } from '@school-erp/tenant';
import { signMfaChallenge, verifyMfaChallenge, mfaRequiredForRoles, ChallengeError } from '../services/mfa';
import { permissionsFor } from '../services/permissions';
import { logger } from '../utils/logger';

const router = Router();

// Single process-wide store. Swap for RedisTokenStore behind a load balancer —
// an in-memory denylist across instances silently fails to revoke.
const store: TokenStore = new MemoryTokenStore();

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
  /** A current TOTP code. Present → MFA is verified in this very call. */
  totp: z.string().regex(/^\d{6}$/).optional(),
});

const mfaVerifySchema = z.object({
  mfaToken: z.string().min(10),
  totp: z.string().regex(/^\d{6}$/),
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

function prismaOf(req: Request): PrismaClient {
  return req.app.get('prisma') as PrismaClient;
}

/**
 * Load the authoritative user record. Roles come from the DB on every login
 * *and* every refresh — a deactivated or demoted user cannot refresh into
 * stale privileges.
 */
async function loadUser(prisma: PrismaClient, userId: string): Promise<LiveUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      isActive: true,
      defaultBranchId: true,
      roleAssignments: {
        where: { isActive: true },
        select: { branchId: true, role: { select: { code: true } } },
      },
    },
  });
  if (!user) return null;

  const roles = user.roleAssignments.map((a) => a.role.code);
  const branchId =
    user.roleAssignments.find((a) => a.branchId)?.branchId ?? user.defaultBranchId;

  return {
    id: user.id,
    email: user.email,
    isActive: user.isActive,
    tenantId: '',
    schoolId: null,
    branchId: branchId ?? null,
    roles,
  };
}

/**
 * Resolve the tenant database for a login.
 *
 * Priority: `X-Tenant-Slug` (which school the client is reaching), then
 * `user_directory` (where this email lives). The two must agree — a mismatch
 * (credentials of school A aimed at school B) is refused before any password
 * work happens, with the same generic message as a bad password.
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
    // 4.2.3 dunning enforcement: a suspended (unpaid) tenant is read-only —
    // no new sessions. CHURNED/DELETING are blocked outright. TRIAL and
    // ACTIVE pass. Same generic problem shape as every other login error.
    if (record.status === 'SUSPENDED') {
      return { error: [403, 'tenant-suspended', 'Subscription Suspended', 'This school\'s subscription is suspended. Contact the school office or billing support.'] };
    }
    if (record.status === 'CHURNED' || record.status === 'DELETING') {
      return { error: [403, 'tenant-closed', 'Account Closed', 'This school\'s account is no longer active.'] };
    }
    prisma = new PrismaClient({ datasourceUrl: record.datastore.connRef });
    tenantId = record.id;

    if (directory && directory.tenantId !== tenantId) {
      return { error: [401, 'authentication-error', 'Invalid Credentials', 'Email or password is incorrect.'] };
    }
  } else if (directory) {
    const record = await cp.tenant.findUnique({
      where: { id: directory.tenantId },
      include: { datastore: true },
    });
    if (record?.datastore) {
      if (record.status === 'SUSPENDED') {
        return { error: [403, 'tenant-suspended', 'Subscription Suspended', 'This school\'s subscription is suspended. Contact the school office or billing support.'] };
      }
      if (record.status === 'CHURNED' || record.status === 'DELETING') {
        return { error: [403, 'tenant-closed', 'Account Closed', 'This school\'s account is no longer active.'] };
      }
      prisma = new PrismaClient({ datasourceUrl: record.datastore.connRef });
      tenantId = record.id;
    }
  }

  if (!prisma) {
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
        defaultBranchId: true,
        mfaSecret: true,
        roleAssignments: {
          where: { isActive: true },
          select: { branchId: true, role: { select: { code: true } } },
        },
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
      problem(res, 401, 'authentication-error', 'Invalid Credentials', 'Email or password is incorrect.');
      return;
    }

    const roles = record.roleAssignments.map((a) => a.role.code);
    const branchId =
      record.roleAssignments.find((a) => a.branchId)?.branchId ?? record.defaultBranchId;

    // MFA challenge for privileged roles with an enrolled secret (2.1.5).
    const needsMfa = mfaRequiredForRoles(roles) && record.mfaSecret !== null;
    if (needsMfa) {
      if (!credentials.totp) {
        // Step 1 of 2: hand back a short-lived, single-use challenge token.
        const challenge = signMfaChallenge(record.id, env.JWT_SECRET);
        res.json({ mfaRequired: true, mfaToken: challenge.token });
        return;
      }
      // `totp` supplied in the login payload — verify it right here.
      const ok = authenticator.verify({ token: credentials.totp, secret: record.mfaSecret! });
      if (!ok) {
        logger.warn(`Failed MFA for ${credentials.email} from ${req.ip}`);
        problem(res, 401, 'authentication-error', 'Invalid Credentials', 'Email or password is incorrect.');
        return;
      }
    } else if (credentials.totp) {
      // A TOTP code was sent for an account that has none — ignore it silently
      // rather than leaking whether the account is MFA-enrolled.
    }

    const user: LiveUser = {
      id: record.id,
      email: record.email,
      isActive: record.isActive,
      tenantId: routed.tenantId,
      schoolId: null,
      branchId: branchId ?? null,
      roles,
    };

    // Keep the directory index fresh: a login is the cheapest moment to repair
    // a drifted entry (idempotent upsert on the email hash).
    const cp = controlPlane(req);
    if (cp && routed.tenantId) {
      await indexTenantUser(cp, routed.tenantId, { id: record.id, email: record.email }).catch(() =>
        undefined,
      );
    }

    const pair = await issueTokenPair(user, tokenConfig(env), store);

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    logger.info(`Login succeeded for ${user.email} (tenant ${user.tenantId || 'local'})`);

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

// ── POST /auth/mfa/verify ── (step 2 of the MFA login)
router.post('/mfa/verify', async (req: Request, res: Response) => {
  const env: IdentityEnv = req.app.get('env');

  let body: z.infer<typeof mfaVerifySchema>;
  try {
    body = mfaVerifySchema.parse(req.body);
  } catch {
    problem(res, 400, 'validation-error', 'Invalid Input', 'mfaToken and a 6-digit totp are required.');
    return;
  }

  try {
    const userId = await verifyMfaChallenge(body.mfaToken, env.JWT_SECRET, store);
    const prisma = prismaOf(req);

    const record = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        isActive: true,
        defaultBranchId: true,
        mfaSecret: true,
        roleAssignments: {
          where: { isActive: true },
          select: { branchId: true, role: { select: { code: true } } },
        },
      },
    });

    if (!record || !record.isActive || !record.mfaSecret) {
      problem(res, 401, 'authentication-error', 'Invalid Credentials', 'Sign-in could not be completed.');
      return;
    }

    const ok = authenticator.verify({ token: body.totp, secret: record.mfaSecret });
    if (!ok) {
      logger.warn(`Failed MFA verify for ${record.email} from ${req.ip}`);
      problem(res, 401, 'authentication-error', 'Invalid Credentials', 'Sign-in could not be completed.');
      return;
    }

    const user = await loadUser(prisma, record.id);
    if (!user) {
      problem(res, 401, 'authentication-error', 'Invalid Credentials', 'Sign-in could not be completed.');
      return;
    }

    const pair = await issueTokenPair(user, tokenConfig(env), store);
    await prisma.user.update({ where: { id: record.id }, data: { lastLogin: new Date() } });
    logger.info(`MFA login succeeded for ${user.email}`);

    res.json({
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresIn: pair.expiresIn,
      tokenType: 'Bearer',
      user: { id: user.id, email: user.email, roles: user.roles, branchId: user.branchId },
    });
  } catch (error) {
    if (error instanceof TokenError || error instanceof ChallengeError) {
      problem(res, 401, 'authentication-error', 'Invalid MFA Challenge', 'Start the sign-in again.');
      return;
    }
    logger.error(`MFA verify error: ${(error as Error).message}`);
    problem(res, 500, 'internal-error', 'Server Error', 'An unexpected error occurred.');
  }
});

// ── POST /auth/mfa/enroll ── (authenticated: generate a secret + otpauth URL)
router.post('/mfa/enroll', async (req: Request, res: Response) => {
  try {
    const env: IdentityEnv = req.app.get('env');
    const ctx = (req as Request & { ctx?: { userId?: string; email?: string } }).ctx;
    if (!ctx?.userId) {
      problem(res, 401, 'authentication-error', 'Unauthorized', 'Authentication required.');
      return;
    }
    const prisma = prismaOf(req);

    const user = await prisma.user.findUnique({ where: { id: ctx.userId } });
    if (!user) {
      problem(res, 404, 'not-found', 'Not Found', 'User not found.');
      return;
    }
    if (user.mfaSecret) {
      problem(res, 409, 'conflict', 'Already Enrolled', 'MFA is already configured for this account. Contact support to reset it.');
      return;
    }

    const secret = authenticator.generateSecret();
    // Store as NOT-yet-confirmed: the account keeps mfaSecret null until
    // activation, so an abandoned enrollment can never lock anyone out.
    await prisma.user.update({
      where: { id: user.id },
      data: { mfaSecret: null },
    });
    // Hand the secret back once; the pending value rides in the response — the
    // client must complete activation for enrollment to persist.
    const otpauth = authenticator.keyuri(user.email, 'School ERP', secret);
    void env;

    res.json({ secret, otpauth, pending: true });
  } catch (error) {
    logger.error(`MFA enroll error: ${(error as Error).message}`);
    problem(res, 500, 'internal-error', 'Server Error', 'An unexpected error occurred.');
  }
});

// ── POST /auth/mfa/activate ── (confirm a code against the pending secret)
router.post('/mfa/activate', async (req: Request, res: Response) => {
  try {
    const ctx = (req as Request & { ctx?: { userId?: string } }).ctx;
    if (!ctx?.userId) {
      problem(res, 401, 'authentication-error', 'Unauthorized', 'Authentication required.');
      return;
    }
    const { secret, totp } = req.body as { secret?: string; totp?: string };
    if (!secret || !totp || !/^\d{6}$/.test(totp) || secret.length < 16) {
      problem(res, 400, 'validation-error', 'Invalid Input', 'secret and a 6-digit totp are required.');
      return;
    }
    const prisma = prismaOf(req);
    const user = await prisma.user.findUnique({ where: { id: ctx.userId } });
    if (!user) {
      problem(res, 404, 'not-found', 'Not Found', 'User not found.');
      return;
    }
    if (user.mfaSecret) {
      problem(res, 409, 'conflict', 'Already Enrolled', 'MFA is already configured for this account.');
      return;
    }
    const ok = authenticator.verify({ token: totp, secret });
    if (!ok) {
      problem(res, 400, 'validation-error', 'Invalid Code', 'The code did not match. Check your authenticator clock and try again.');
      return;
    }
    await prisma.user.update({ where: { id: user.id }, data: { mfaSecret: secret } });
    logger.info(`MFA enrolled for ${user.email}`);
    res.json({ enrolled: true });
  } catch (error) {
    logger.error(`MFA activate error: ${(error as Error).message}`);
    problem(res, 500, 'internal-error', 'Server Error', 'An unexpected error occurred.');
  }
});

// ── POST /auth/refresh ──
router.post('/refresh', async (req: Request, res: Response) => {
  const prisma = prismaOf(req);
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
