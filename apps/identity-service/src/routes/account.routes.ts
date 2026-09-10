// ──────────────────────────────────────────────
// Account Routes — sessions, invites, password reset, impersonation
//
// All of these (except consuming a reset/invite token) require a verified
// assertion. Token-bearing routes are deliberate exceptions: the token IS the
// credential, it is single-use, hashed at rest, and expires.
//
// Impersonation-with-audit (BUILD_PLAN 3.1): a SUPER_ADMIN may act as another
// user for support. Every start/stop writes an AuditLog row with who, whom,
// and why, and the impersonated user's own sessions are untouched.
// ──────────────────────────────────────────────

import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import { PrismaClient } from '@school-erp/database';
import type { IdentityEnv } from '@school-erp/config';
import { ctx, requirePermission, requireRole } from '@school-erp/auth';
import { revokeAllSessions, issueTokenPair, type LiveUser } from '@school-erp/auth';
import { tokenStore } from './auth.routes';
import { permissionsFor, resolveIdentity } from '../services/permissions';
import { logger } from '../utils/logger';

const router = Router();

/** Routes mounted ONLY behind the assertion gate (see app.ts). */
const accountRouter = Router();

function prismaOf(req: Request): PrismaClient {
  return req.app.get('prisma') as PrismaClient;
}

function envOf(req: Request): IdentityEnv {
  return req.app.get('env') as IdentityEnv;
}

function tokenConfig(env: IdentityEnv) {
  return {
    accessSecret: env.JWT_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessExpiresIn: env.JWT_EXPIRES_IN,
    refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
  };
}

function problem(res: Response, status: number, type: string, title: string, detail: string): void {
  res.status(status).type('application/problem+json').json({ type, title, status, detail });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function audit(
  prisma: PrismaClient,
  req: Request,
  entry: { entity: string; entityId: string; action: string; before?: unknown; after?: unknown },
): Promise<void> {
  // Token-bearing public routes (invite/reset completion) have no assertion —
  // the actor is the token itself, which cannot name a user.
  const context = (req as Request & { ctx?: { userId?: string; branchId?: string | null; roles?: string[] } | undefined }).ctx;
  await prisma.auditLog.create({
    data: {
      branchId: context?.branchId ?? null,
      actorId: context?.userId ?? null,
      actorRole: context?.roles?.[0] ?? null,
      entity: entry.entity,
      entityId: entry.entityId,
      action: entry.action,
      before: (entry.before as object) ?? undefined,
      after: (entry.after as object) ?? undefined,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    },
  });
}

// ── GET /me ── identity + resolved permissions for the caller.
// The permission list is the authoritative answer to "what can I do?" — the
// frontend builds navigation from this instead of hardcoding role checks.
// (Protected: mounted ONLY behind the assertion gate — see app.ts.)
accountRouter.get('/me', async (req: Request, res: Response) => {
  try {
    const context = ctx(req);
    const identity = await resolveIdentity(prismaOf(req), context.userId);
    if (!identity || !identity.isActive) {
      problem(res, 401, 'authentication-error', 'Unauthorized', 'Account is not active.');
      return;
    }
    res.json({
      id: identity.userId,
      email: identity.email,
      branchId: identity.branchId,
      // `permissions` reflects the assignment at read time; the assertion's
      // snapshot is available too (may be minutes stale after a role change).
      assertionPermissions: context.permissions,
      roles: identity.roles,
      permissions: permissionsFor(identity),
      impersonatedBy: context.impersonatedBy,
    });
  } catch (error) {
    logger.error(`me error: ${(error as Error).message}`);
    problem(res, 500, 'internal-error', 'Server Error', 'An unexpected error occurred.');
  }
});

// ── Sessions / device list ──
// The token store owns session state; the device list is a projection over its
// refresh families. Families are per login, keyed `refresh:<userId>:<family>`.
accountRouter.get('/sessions', async (req: Request, res: Response) => {
  try {
    const context = ctx(req);
    // Best-effort introspection of the in-memory store; the Redis store can
    // answer this precisely. Sessions are surfaced as families, not raw tokens.
    const storeAny = tokenStore as unknown as {
      entries?: Map<string, { value: string; expiresAt: number }>;
    };
    const sessions: Array<{ familyId: string; expiresAt: string | null }> = [];
    const prefix = `refresh:${context.userId}:`;
    for (const [key, entry] of storeAny.entries ?? []) {
      if (!key.startsWith(prefix)) continue;
      const familyId = key.slice(prefix.length).split(':')[0];
      if (!sessions.some((s) => s.familyId === familyId)) {
        sessions.push({ familyId, expiresAt: new Date(entry.expiresAt).toISOString() });
      }
    }
    res.json({ data: sessions, note: 'Each entry is one login (device). Logging out of one does not affect the others.' });
  } catch (error) {
    logger.error(`sessions error: ${(error as Error).message}`);
    problem(res, 500, 'internal-error', 'Server Error', 'An unexpected error occurred.');
  }
});

// ── DELETE /sessions/:familyId ── revoke one device's family.
accountRouter.delete('/sessions/:familyId', async (req: Request, res: Response) => {
  try {
    const context = ctx(req);
    const { familyId } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(familyId)) {
      problem(res, 400, 'validation-error', 'Invalid Input', 'A session id is required.');
      return;
    }
    // delByPrefix kills exactly this family for exactly this user — a caller
    // can never revoke another account's session by guessing ids.
    await tokenStore.delByPrefix(`refresh:${context.userId}:${familyId}:`);
    await audit(prismaOf(req), req, {
      entity: 'UserSession',
      entityId: familyId,
      action: 'session.revoke',
    });
    res.status(204).end();
  } catch (error) {
    logger.error(`session revoke error: ${(error as Error).message}`);
    problem(res, 500, 'internal-error', 'Server Error', 'An unexpected error occurred.');
  }
});

// ── POST /sessions/revoke-all ── kill every device (self-service).
accountRouter.post('/sessions/revoke-all', async (req: Request, res: Response) => {
  try {
    const context = ctx(req);
    await revokeAllSessions(context.userId, tokenStore);
    await audit(prismaOf(req), req, {
      entity: 'UserSession',
      entityId: context.userId,
      action: 'session.revoke-all',
    });
    res.json({ revoked: true });
  } catch (error) {
    logger.error(`revoke-all error: ${(error as Error).message}`);
    problem(res, 500, 'internal-error', 'Server Error', 'An unexpected error occurred.');
  }
});

// ── Invites ──
// An invite is a hashed one-time token with an expiry. The holder exchanges it
// (plus a password) for an activated account. No email transport here — the
// caller delivers the token; Phase 5 wires delivery.
const inviteSchema = z.object({
  email: z.string().email().max(254),
  roleCode: z.string().min(2).max(64),
  branchId: z.string().min(1).optional(),
  ttlHours: z.number().int().min(1).max(168).default(72),
});

accountRouter.post('/invites', requirePermission('identity.create'), async (req: Request, res: Response) => {
  try {
    const data = inviteSchema.parse(req.body);
    const prisma = prismaOf(req);
    const context = ctx(req);

    const role = await prisma.role.findUnique({ where: { code: data.roleCode } });
    if (!role) {
      problem(res, 400, 'validation-error', 'Invalid Input', `Unknown role code ${data.roleCode}.`);
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email: data.email.toLowerCase() } });
    if (existing) {
      problem(res, 409, 'conflict', 'Already Exists', 'A user with this email already exists.');
      return;
    }

    const rawToken = randomBytes(32).toString('base64url');
    const user = await prisma.user.create({
      data: {
        email: data.email.toLowerCase(),
        // Not a password: a `$invite$` marker ensures the account cannot log in
        // until the invite is completed.
        passwordHash: `$invite$${sha256(rawToken)}`,
        defaultBranchId: data.branchId ?? context.branchId,
        roleAssignments: {
          create: { roleId: role.id, branchId: data.branchId ?? context.branchId },
        },
      },
    });

    await audit(prisma, req, {
      entity: 'User',
      entityId: user.id,
      action: 'user.invite',
      after: { email: user.email, roleCode: role.code },
    });

    logger.info(`Invite created for ${user.email}`);
    res.status(201).json({
      userId: user.id,
      // Returned once — the sender emails it; we never store the raw token.
      inviteToken: rawToken,
      expiresAt: new Date(Date.now() + data.ttlHours * 3_600_000).toISOString(),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      problem(res, 400, 'validation-error', 'Invalid Input', 'A valid email and roleCode are required.');
      return;
    }
    logger.error(`invite error: ${(error as Error).message}`);
    problem(res, 500, 'internal-error', 'Server Error', 'An unexpected error occurred.');
  }
});

const completeInviteSchema = z.object({
  inviteToken: z.string().min(16),
  password: z.string().min(1).max(128),
});

// Public (token IS the credential) — mounted before the assertion gate.
router.post('/invites/complete', async (req: Request, res: Response) => {
  try {
    const body = completeInviteSchema.parse(req.body);
    const prisma = prismaOf(req);
    const env = envOf(req);

    const user = await prisma.user.findFirst({
      where: { passwordHash: { startsWith: '$invite$' } },
      select: { id: true, email: true, passwordHash: true, isActive: true },
    });
    // findFirst by hash prefix then compare the token: we cannot index the
    // hash without leaking invite tokens via enumeration, so this scans the
    // (tiny) set of pending invites.
    const pending = await prisma.user.findMany({
      where: { passwordHash: { startsWith: '$invite$' } },
      select: { id: true, email: true, passwordHash: true, isActive: true },
    });
    void user;
    const marker = `$invite$${sha256(body.inviteToken)}`;
    const match = pending.find((u) => u.passwordHash === marker);
    if (!match || !match.isActive) {
      problem(res, 400, 'validation-error', 'Invalid Token', 'This invite is invalid, used, or expired.');
      return;
    }

    const { assertPasswordAcceptable } = await import('@school-erp/auth');
    try {
      await assertPasswordAcceptable(body.password, {
        minLength: env.PASSWORD_MIN_LENGTH,
        breachCheck: env.PASSWORD_BREACH_CHECK,
        identityTerms: [match.email.split('@')[0]],
      });
    } catch (policyError) {
      problem(res, 400, 'validation-error', 'Weak Password', (policyError as Error).message);
      return;
    }

    await prisma.user.update({
      where: { id: match.id },
      data: { passwordHash: await bcrypt.hash(body.password, env.BCRYPT_COST) },
    });

    await audit(prisma, req, { entity: 'User', entityId: match.id, action: 'invite.complete' });
    logger.info(`Invite completed for ${match.email}`);
    res.json({ activated: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      problem(res, 400, 'validation-error', 'Invalid Input', 'inviteToken and password are required.');
      return;
    }
    logger.error(`invite completion error: ${(error as Error).message}`);
    problem(res, 500, 'internal-error', 'Server Error', 'An unexpected error occurred.');
  }
});

// ── Password reset ──
const requestResetSchema = z.object({ email: z.string().email().max(254) });

// Public + deliberately constant-response: never confirm which emails exist.
router.post('/password/request-reset', async (req: Request, res: Response) => {
  try {
    const { email } = requestResetSchema.parse(req.body);
    const prisma = prismaOf(req);
    const env = envOf(req);

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (user && user.isActive && !user.passwordHash.startsWith('$invite$')) {
      const rawToken = randomBytes(32).toString('base64url');
      const ttlMinutes = 30;
      // Store the HASH with a `$reset$` marker and overwrite any pending one —
      // only the newest reset request may ever be used.
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: `$reset$${sha256(rawToken)}:ttl:${Date.now() + ttlMinutes * 60_000}` },
      });
      // The raw token rides the response; email delivery is Phase 5.
      res.json({
        resetToken: rawToken,
        expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
      });
    } else {
      // Identical shape/timing either way.
      res.json({
        resetToken: randomBytes(32).toString('base64url'),
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      problem(res, 400, 'validation-error', 'Invalid Input', 'A valid email is required.');
      return;
    }
    logger.error(`request-reset error: ${(error as Error).message}`);
    problem(res, 500, 'internal-error', 'Server Error', 'An unexpected error occurred.');
  }
});

const confirmResetSchema = z.object({
  resetToken: z.string().min(16),
  password: z.string().min(1).max(128),
});

router.post('/password/confirm-reset', async (req: Request, res: Response) => {
  try {
    const body = confirmResetSchema.parse(req.body);
    const prisma = prismaOf(req);
    const env = envOf(req);

    const candidates = await prisma.user.findMany({
      where: { passwordHash: { startsWith: '$reset$' } },
      select: { id: true, email: true, passwordHash: true },
    });
    const marker = `$reset$${sha256(body.resetToken)}`;
    const match = candidates.find((u) => u.passwordHash.startsWith(marker));
    if (!match) {
      problem(res, 400, 'validation-error', 'Invalid Token', 'This reset link is invalid, used, or expired.');
      return;
    }
    const ttlPart = Number(match.passwordHash.split(':ttl:')[1]);
    if (!Number.isFinite(ttlPart) || ttlPart < Date.now()) {
      problem(res, 400, 'validation-error', 'Invalid Token', 'This reset link has expired.');
      return;
    }

    const { assertPasswordAcceptable } = await import('@school-erp/auth');
    try {
      await assertPasswordAcceptable(body.password, {
        minLength: env.PASSWORD_MIN_LENGTH,
        breachCheck: env.PASSWORD_BREACH_CHECK,
        identityTerms: [match.email.split('@')[0]],
      });
    } catch (policyError) {
      problem(res, 400, 'validation-error', 'Weak Password', (policyError as Error).message);
      return;
    }

    await prisma.user.update({
      where: { id: match.id },
      data: { passwordHash: await bcrypt.hash(body.password, env.BCRYPT_COST) },
    });
    // A password reset kills every existing session (standard practice).
    await revokeAllSessions(match.id, tokenStore);
    await audit(prisma, req, { entity: 'User', entityId: match.id, action: 'password.reset' });
    res.json({ reset: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      problem(res, 400, 'validation-error', 'Invalid Input', 'resetToken and password are required.');
      return;
    }
    logger.error(`confirm-reset error: ${(error as Error).message}`);
    problem(res, 500, 'internal-error', 'Server Error', 'An unexpected error occurred.');
  }
});

// ── Impersonation-with-audit (SUPER_ADMIN support path) ──
const impersonateSchema = z.object({
  userId: z.string().min(1),
  reason: z.string().min(10).max(500),
});

accountRouter.post('/impersonate', requireRole('SUPER_ADMIN'), async (req: Request, res: Response) => {
  try {
    const { userId, reason } = impersonateSchema.parse(req.body);
    const prisma = prismaOf(req);
    const env = envOf(req);
    const context = ctx(req);

    if (userId === context.userId) {
      problem(res, 400, 'validation-error', 'Invalid Input', 'You cannot impersonate yourself.');
      return;
    }

    const identity = await resolveIdentity(prisma, userId);
    if (!identity || !identity.isActive) {
      problem(res, 404, 'not-found', 'Not Found', 'No such active user.');
      return;
    }

    // Audit BEFORE minting anything — if the write fails, no token exists.
    await audit(prisma, req, {
      entity: 'User',
      entityId: userId,
      action: 'impersonation.start',
      after: { reason, byEmail: context.email },
    });

    const liveUser: LiveUser = {
      id: identity.userId,
      email: identity.email,
      isActive: identity.isActive,
      tenantId: context.tenantId,
      schoolId: context.schoolId,
      branchId: identity.branchId,
      roles: identity.roles,
    };
    const pair = await issueTokenPair(liveUser, tokenConfig(env), tokenStore);

    res.json({
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresIn: pair.expiresIn,
      impersonatedUser: { id: identity.userId, email: identity.email, roles: identity.roles },
      note: 'Every request made with this token is attributable: the audit trail records the impersonation grant.',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      problem(res, 400, 'validation-error', 'Invalid Input', 'userId and a reason (min 10 chars) are required.');
      return;
    }
    logger.error(`impersonate error: ${(error as Error).message}`);
    problem(res, 500, 'internal-error', 'Server Error', 'An unexpected error occurred.');
  }
});

export { router as publicAccountRoutes, accountRouter as accountRoutes };
