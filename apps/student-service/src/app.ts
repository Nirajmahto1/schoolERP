// ──────────────────────────────────────────────
// School ERP — Student Service (app factory)
//
// Split from index.ts so tests can build the app with an injected Prisma
// client and an explicitly-parsed environment, without binding a port or
// validating the real .env at import time.
// ──────────────────────────────────────────────

import express, { type Express } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { requireAssertion, stripSpoofableHeaders } from '@school-erp/auth';
import type { IdentityEnv } from '@school-erp/config';
import { authRoutes } from './routes/auth.routes';
import { studentRoutes } from './routes/student.routes';
import { parentRoutes } from './routes/parent.routes';
import { logger } from './utils/logger';

/** MUST equal the gateway route-table audience for this service. */
export const SERVICE_NAME = 'student-service';

export interface IdentityAppOptions {
  env: IdentityEnv;
  prisma: PrismaClient;
}

export function createIdentityApp({ env, prisma }: IdentityAppOptions): Express {
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

  // ── /auth is reached before a user has a token, so it cannot require an
  //    assertion. It is still gateway-only in deployment (network policy), and
  //    the gateway rate-limits it.
  app.use('/auth', authRoutes);

  // ── Everything else requires a gateway-signed, audience-bound assertion.
  //    A request arriving directly on the service port without one gets 401.
  const assertion = requireAssertion(env.INTERNAL_ASSERTION_PUBLIC_KEY, SERVICE_NAME);
  app.use('/students', assertion, studentRoutes);
  app.use('/parents', assertion, parentRoutes);

  return app;
}