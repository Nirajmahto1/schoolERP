// ──────────────────────────────────────────────
// School ERP — Student Service
// Students, parents, admissions, and (until Phase 3) authentication.
// ──────────────────────────────────────────────

import express from 'express';
import morgan from 'morgan';
import { PrismaClient } from '@school-erp/database';
import { loadIdentityEnv } from '@school-erp/config';
import { requireAssertion, stripSpoofableHeaders } from '@school-erp/auth';
import { authRoutes } from './routes/auth.routes';
import { studentRoutes } from './routes/student.routes';
import { parentRoutes } from './routes/parent.routes';
import { logger } from './utils/logger';

const SERVICE_NAME = 'student-service';

const env = loadIdentityEnv();
const app = express();
const prisma = new PrismaClient();

// Never trust a client-supplied identity header, even on public routes.
app.use(stripSpoofableHeaders);

// No CORS here: this service is only reachable through the gateway, which owns
// the browser-facing CORS policy. Adding permissive CORS to an internal service
// invites direct browser access that bypasses the gateway.
app.use(express.json({ limit: '1mb' }));
app.use(
  morgan('combined', {
    stream: { write: (msg: string) => logger.info(msg.trim()) },
    skip: (req) => req.path === '/health',
  }),
);

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
//    A request arriving directly on port 4001 without one gets 401.
const assertion = requireAssertion(env.INTERNAL_ASSERTION_PUBLIC_KEY, SERVICE_NAME);
app.use('/students', assertion, studentRoutes);
app.use('/parents', assertion, parentRoutes);

const server = app.listen(env.PORT_STUDENT_SERVICE, () => {
  logger.info(`📚 ${SERVICE_NAME} listening on http://localhost:${env.PORT_STUDENT_SERVICE}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info(`${signal} received — draining`);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

export { app, prisma };
