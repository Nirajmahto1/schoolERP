// ──────────────────────────────────────────────
// School ERP — API Gateway entrypoint
// ──────────────────────────────────────────────

import { loadGatewayEnv } from '@school-erp/config';
import { buildApp } from './app';
import { logger } from './utils/logger';

// Validates every required variable and exits with a readable report if any is
// missing or is still set to a placeholder. No fallback secrets exist.
const env = loadGatewayEnv();

const app = buildApp({ env });

const server = app.listen(env.PORT_GATEWAY, () => {
  logger.info(`🚀 API Gateway listening on http://localhost:${env.PORT_GATEWAY}`);
  logger.info(`   env=${env.NODE_ENV} cors=${env.CORS_ALLOWED_ORIGINS.join(', ')}`);
});

// Attach the WS upgrade dispatcher built at factory time (see buildApp) —
// one listener, routed by public prefix. Without this, a client whose first
// request is a WebSocket upgrade gets no answer.
const wsDispatcher = (app as unknown as {
  wsUpgradeDispatcher?: (req: import('http').IncomingMessage, socket: import('net').Socket, head: Buffer) => void;
}).wsUpgradeDispatcher;
if (wsDispatcher) {
  server.on('upgrade', wsDispatcher);
  logger.info('   ws upgrade dispatcher attached');
}

// Let in-flight school requests finish before the process dies.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info(`${signal} received — draining connections`);
    server.close(() => {
      logger.info('Gateway shut down cleanly');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

export default app;
