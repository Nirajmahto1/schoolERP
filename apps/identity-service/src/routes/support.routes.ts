// ──────────────────────────────────────────────
// Support-grant activation (BUILD_PLAN §13.4.2)
//
// "Support access via time-boxed, audited support_grant — never a shared
// admin password." The console creates a grant and shows the platform
// engineer a one-time activation code; this public route redeems it for a
// time-boxed session inside the school.
//
// The security shape, deliberately:
//   • the code is 32 bytes of CSPRNG, stored ONLY as SHA-256 — a DB dump
//     never yields live access — and single-use (updateMany guards the
//     two-concurrent-activations race);
//   • the granted session is the tenant's SUPER_ADMIN owner account — the
//     same blast radius the existing SUPER_ADMIN-only impersonation feature
//     has — but every downstream action carries impersonatedBy =
//     "support-grant:<id>", so the audit trail names the grant, not just
//     the account;
//   • activation lands in the school's own AuditLog BEFORE any token
//     exists, so "can your staff see our data?" has a demonstrable answer;
//   • revocation is one UPDATE in the control plane — the school can demand
//     it mid-window and it takes effect on the next refresh.
// ──────────────────────────────────────────────

import { createHash } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@school-erp/database';
import type { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import type { IdentityEnv } from '@school-erp/config';
import { issueTokenPair, type LiveUser } from '@school-erp/auth';
import { tokenStore } from './auth.routes';
import { resolveIdentity } from '../services/permissions';
import { logger } from '../utils/logger';

const router = Router();

const activateSchema = z.object({
  code: z.string().min(16).max(80),
});

function prismaOf(req: Request): PrismaClient {
  return req.app.get('prisma') as PrismaClient;
}

function controlPlaneOf(req: Request): ControlPlaneClient {
  return req.app.get('controlPlane') as ControlPlaneClient;
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

function problem(res: Response, status: number, type: string, title: string, detail: string) {
  res.status(status).type('application/problem+json').json({ type, title, status, detail });
}

// ── POST /auth/support/activate — public; the code IS the credential ──
router.post('/support/activate', async (req: Request, res: Response) => {
  try {
    const { code } = activateSchema.parse(req.body);
    const prisma = prismaOf(req);
    const cp = controlPlaneOf(req);
    const env = envOf(req);

    const codeHash = createHash('sha256').update(code).digest('hex');
    const grant = await cp.supportGrant.findFirst({
      where: { codeHash },
      include: { tenant: { select: { id: true, slug: true } } },
    });
    if (!grant) {
      problem(res, 401, 'invalid-code', 'Invalid Code', 'No such support grant.');
      return;
    }
    if (grant.usedAt || grant.revokedAt || grant.expiresAt.getTime() <= Date.now()) {
      problem(res, 409, 'grant-consumed', 'Grant Unavailable', 'This grant was already used, revoked, or has expired.');
      return;
    }

    // Single-use claim: the conditional updateMany is the race guard — two
    // concurrent activations, exactly one wins.
    const claimed = await cp.supportGrant.updateMany({
      where: { id: grant.id, usedAt: null, revokedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) {
      problem(res, 409, 'grant-consumed', 'Grant Unavailable', 'This grant was already claimed.');
      return;
    }

    // The granted identity: the tenant's owner (SUPER_ADMIN, school-wide
    // assignment). Present in every tenant by construction of setup.
    const owner = await prisma.user.findFirst({
      where: {
        isActive: true,
        roleAssignments: { some: { isActive: true, role: { code: 'SUPER_ADMIN' } } },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!owner) {
      await cp.supportGrant.update({ where: { id: grant.id }, data: { usedAt: null } });
      problem(res, 503, 'no-owner', 'Not Provisioned', 'This school has no active owner account yet.');
      return;
    }
    const identity = await resolveIdentity(prisma, owner.id);
    if (!identity || !identity.isActive) {
      await cp.supportGrant.update({ where: { id: grant.id }, data: { usedAt: null } });
      problem(res, 503, 'no-owner', 'Not Provisioned', 'The owner account exists but is not active.');
      return;
    }

    // Audit FIRST in the school's own trail — if the write fails, no token.
    try {
      await prisma.auditLog.create({
        data: {
          entity: 'User',
          entityId: owner.id,
          action: 'support_grant.activation',
          actorId: null,
          actorRole: 'PLATFORM_SUPPORT',
          branchId: identity.branchId,
          before: {},
          after: {
            grantId: grant.id,
            tenantSlug: grant.tenant.slug,
            reason: grant.reason,
            expiresAt: grant.expiresAt.toISOString(),
          },
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });
    } catch (err) {
      logger.warn(`support-grant audit write failed, aborting activation: ${(err as Error).message}`);
      await cp.supportGrant.update({ where: { id: grant.id }, data: { usedAt: null } });
      problem(res, 500, 'internal-error', 'Server Error', 'Activation audit could not be recorded.');
      return;
    }

    const liveUser: LiveUser = {
      id: identity.userId,
      email: identity.email,
      isActive: identity.isActive,
      tenantId: grant.tenantId,
      schoolId: null,
      branchId: identity.branchId,
      roles: identity.roles,
      // Attribution chain: every assertion minted from this session names
      // the grant — the audit trail reads "owner, via support-grant:<id>".
      impersonatedBy: `support-grant:${grant.id}`,
    };
    const pair = await issueTokenPair(liveUser, tokenConfig(env), tokenStore);

    res.json({
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresIn: pair.expiresIn,
      grant: { id: grant.id, reason: grant.reason, expiresAt: grant.expiresAt.toISOString() },
      note: 'Session acts as the school owner with grant attribution. Revoke anytime from the platform console.',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      problem(res, 400, 'validation-error', 'Invalid Input', 'A code (16–80 chars) is required.');
      return;
    }
    logger.error(`support activate error: ${(error as Error).message}`);
    problem(res, 500, 'internal-error', 'Server Error', 'An unexpected error occurred.');
  }
});

// ── GET /auth/support/status?code=… — public state probe ──
// Lets the engineer (or the school) confirm a grant's state without any
// session. Surfaces nothing beyond what the school already knows.
router.get('/support/status', async (req: Request, res: Response) => {
  try {
    const code = String(req.query.code ?? '');
    if (code.length < 16) {
      problem(res, 400, 'validation-error', 'Invalid Input', 'A code query parameter is required.');
      return;
    }
    const cp = controlPlaneOf(req);
    const codeHash = createHash('sha256').update(code).digest('hex');
    const grant = await cp.supportGrant.findFirst({
      where: { codeHash },
      select: { reason: true, expiresAt: true, usedAt: true, revokedAt: true, createdAt: true },
    });
    if (!grant) {
      problem(res, 404, 'not-found', 'Not Found', 'No such support grant.');
      return;
    }
    const state = grant.revokedAt
      ? 'revoked'
      : grant.usedAt
        ? 'activated'
        : grant.expiresAt.getTime() <= Date.now()
          ? 'expired'
          : 'pending';
    res.json({
      state,
      reason: grant.reason,
      createdAt: grant.createdAt,
      expiresAt: grant.expiresAt,
      usedAt: grant.usedAt,
      revokedAt: grant.revokedAt,
    });
  } catch (error) {
    logger.error(`support status error: ${(error as Error).message}`);
    problem(res, 500, 'internal-error', 'Server Error', 'An unexpected error occurred.');
  }
});

export { router as supportRoutes };
