// ──────────────────────────────────────────────
// Health & readiness probes
//
// GET /health answers "is the process alive" unconditionally; GET /ready
// answers "can this instance take traffic" and checks real dependencies.
// Deployments gate on /ready so a service whose database vanished is removed
// from the load balancer instead of serving 500s.
// ──────────────────────────────────────────────

import type { RequestHandler, Router } from 'express';

export interface ReadinessCheck {
  name: string;
  run: () => Promise<void>;
}

export function healthRoutes(readiness: ReadinessCheck[] = []): {
  router: Router;
  register: (router: Router) => void;
} {
  // Imported lazily by type only; express is a peer dependency.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const express = require('express') as typeof import('express');
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  router.get('/ready', async (_req, res) => {
    const failed: string[] = [];
    for (const check of readiness) {
      try {
        await check.run();
      } catch {
        failed.push(check.name);
      }
    }
    if (failed.length > 0) {
      res.status(503).json({
        type: 'unavailable',
        title: 'Not Ready',
        status: 503,
        detail: `Dependencies not reachable: ${failed.join(', ')}`,
      });
      return;
    }
    res.json({ status: 'ready' });
  });

  return { router, register: (target: Router) => target.use(router) };
}

/** Readiness probe helper: a raw `SELECT 1` against a Prisma client. */
export function prismaPing(prismaLike: { $queryRaw: (q: TemplateStringsArray) => Promise<unknown> }): ReadinessCheck {
  return { name: 'database', run: async () => { await prismaLike.$queryRaw`SELECT 1`; } };
}

export type { RequestHandler };
