// ──────────────────────────────────────────────
// School ERP — Provision Service (app factory)
//
// Owns the first-run experience and branch management:
//   /setup/*    guarded-public wizard endpoints (lock permanently on first run)
//   /branches/* gated management for the signed-in owner
//
// It is a NODE service (Express, not Python like analytics) because it shares
// the tenant Prisma client and the assertion middleware stack.
// ──────────────────────────────────────────────

import express, { type Express } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { requireAssertion, stripSpoofableHeaders } from '@school-erp/auth';
import { jsonRequestLogger, metricsMiddleware } from '@school-erp/http';
import type { ProvisionEnv } from '@school-erp/config';
import { setupRouter, branchRouter } from './routes';
import { logger } from './utils/logger';

/** MUST equal the gateway route-table audience for this service. */
export const SERVICE_NAME = 'provision-service';

export interface ProvisionAppOptions {
  env: ProvisionEnv;
  prisma: PrismaClient;
  /** Optional: single-DB deployments may run without a control plane. */
  controlPlane?: ControlPlaneClient;
}

export function createProvisionApp({ env, prisma, controlPlane }: ProvisionAppOptions): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(stripSpoofableHeaders);

  // Phase 11 observability: Prometheus metrics + structured JSON request log.
  app.use(metricsMiddleware()[0]);
  app.use(jsonRequestLogger({ service: SERVICE_NAME }));

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

  // Public: the wizard page needs /setup/status and POST /setup before any
  // account exists. POST /setup is additionally locked by the empty-database
  // guard (and SETUP_TOKEN when configured).
  app.use('/setup', setupRouter);

  // Multer errors (oversize file, unexpected field) surface here as generic
  // MiddlewareErrors; map them to honest problem+json responses instead of
  // the default HTML 500.
  app.use(
    (
      err: Error & { code?: string; field?: string },
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ): void => {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).type('application/problem+json').json({
          type: 'logo-too-large',
          title: 'Logo Too Large',
          status: 413,
          detail: 'Logo must be 2 MB or smaller.',
        });
        return;
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        res.status(400).type('application/problem+json').json({
          type: 'logo-unexpected-file',
          title: 'Bad Upload',
          status: 400,
          detail: `Unexpected file field ${err.field ?? ''}. Use the "logo" field.`,
        });
        return;
      }
      next(err);
    },
  );

  // Gated: branch management requires a gateway-signed, audience-bound
  // assertion. Direct port access without one gets 401.
  const assertion = requireAssertion(env.INTERNAL_ASSERTION_PUBLIC_KEY, SERVICE_NAME);
  app.use('/branches', assertion, branchRouter);

  return app;
}
