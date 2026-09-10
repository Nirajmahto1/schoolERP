// ──────────────────────────────────────────────
// School ERP — Identity Service (app factory)
//
// Phase 3.1: auth, MFA, sessions, invites, password reset, permission
// resolution, and impersonation live here — extracted from student-service so
// the student module stays about students.
//
// Route mounting is split deliberately:
//   PUBLIC  /auth/*            login, mfa/verify, refresh, logout,
//                              invites/complete, password/*
//   GATED   /auth/*            me, sessions, invites (create), impersonate
// Express matches in registration order, so gated and public handlers live on
// two separate routers — a public mount can never shadow a gated one.
// ──────────────────────────────────────────────

import express, { type Express } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { requireAssertion, stripSpoofableHeaders } from '@school-erp/auth';
import type { IdentityEnv } from '@school-erp/config';
import { authRoutes } from './routes/auth.routes';
import { accountRoutes, publicAccountRoutes } from './routes/account.routes';
import { logger } from './utils/logger';

/** MUST equal the gateway route-table audience for this service. */
export const SERVICE_NAME = 'identity-service';

export interface IdentityAppOptions {
  env: IdentityEnv;
  prisma: PrismaClient;
  /**
   * Control-plane client for login routing (user_directory). When omitted —
   * as in unit tests — login runs in single-database mode.
   */
  controlPlane?: ControlPlaneClient;
}

export function createIdentityApp({ env, prisma, controlPlane }: IdentityAppOptions): Express {
  const app = express();

  app.disable('x-powered-by');

  // Never trust a client-supplied identity header, even on public routes.
  app.use(stripSpoofableHeaders);

  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    if (req.path !== '/health') logger.info(`${req.method} ${req.path}`);
    next();
  });

  app.set('prisma', prisma);
  app.set('env', env);
  if (controlPlane) app.set('controlPlane', controlPlane);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: SERVICE_NAME, timestamp: new Date().toISOString() });
  });

  app.get('/ready', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ready', service: SERVICE_NAME });
    } catch {
      res.status(503).json({
        type: 'unavailable',
        title: 'Not Ready',
        status: 503,
        detail: 'Database is not reachable.',
      });
    }
  });

  // ── Public subset: reached before a user has a token. The gateway is the
  //    only legitimate caller in deployment (network policy) and rate-limits
  //    these. Token-bearing routes (/invites/complete, /password/*) carry
  //    their own one-time credentials.
  app.use('/auth', authRoutes);
  app.use('/auth', publicAccountRoutes);

  // ── Everything else requires a gateway-signed, audience-bound assertion.
  //    A request arriving directly on the service port without one gets 401.
  const assertion = requireAssertion(env.INTERNAL_ASSERTION_PUBLIC_KEY, SERVICE_NAME);
  app.use('/auth', assertion, accountRoutes);

  return app;
}
