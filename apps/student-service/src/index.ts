// ──────────────────────────────────────────────
// School ERP — Student Service entrypoint
// Students, parents, admissions, and (until Phase 3) authentication.
// ──────────────────────────────────────────────

import { PrismaClient } from '@school-erp/database';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { loadIdentityEnv } from '@school-erp/config';
import { listenWithGracefulShutdown } from '@school-erp/auth';
import { createIdentityApp, SERVICE_NAME } from './app';
import { logger } from './utils/logger';

// Validates every required variable and exits with a readable report if any is
// missing or still placeholder. No fallback secrets exist.
const env = loadIdentityEnv();
const prisma = new PrismaClient();
// Login routing: user_directory lives in the control plane (Phase 1.1).
const controlPlane = new ControlPlaneClient({ datasourceUrl: env.CONTROL_PLANE_DATABASE_URL });
const app = createIdentityApp({ env, prisma, controlPlane });

listenWithGracefulShutdown(
  app,
  env.PORT_STUDENT_SERVICE,
  SERVICE_NAME,
  async () => {
    await prisma.$disconnect();
    await controlPlane.$disconnect();
  },
  (msg: string) => logger.info(msg),
);

export { app, prisma };
