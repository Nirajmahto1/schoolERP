// ──────────────────────────────────────────────
// School ERP — Provision Service entrypoint
// First-run setup wizard + branch management.
// ──────────────────────────────────────────────

import { PrismaClient } from '@school-erp/database';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { loadProvisionEnv } from '@school-erp/config';
import { listenWithGracefulShutdown } from '@school-erp/auth';
import { createProvisionApp, SERVICE_NAME } from './app';
import { logger } from './utils/logger';

const env = loadProvisionEnv();
const prisma = new PrismaClient();
// Optional at runtime: when CONTROL_PLANE_DATABASE_URL is absent/unreachable
// the service still boots and setup completes; login then runs single-DB.
const controlPlane = env.CONTROL_PLANE_DATABASE_URL
  ? new ControlPlaneClient({ datasourceUrl: env.CONTROL_PLANE_DATABASE_URL })
  : undefined;
const app = createProvisionApp({ env, prisma, controlPlane });

listenWithGracefulShutdown(
  app,
  env.PORT_PROVISION_SERVICE,
  SERVICE_NAME,
  async () => {
    await prisma.$disconnect();
    await controlPlane?.$disconnect();
  },
  (msg: string) => logger.info(msg),
);

export { app, prisma };
