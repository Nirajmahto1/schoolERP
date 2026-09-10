// ──────────────────────────────────────────────
// School ERP — Exam Service entrypoint
// ──────────────────────────────────────────────

import { PrismaClient } from '@school-erp/database';
import { loadServiceEnv } from '@school-erp/config';
import { listenWithGracefulShutdown } from '@school-erp/auth';
import { createExamApp } from './app';

const SERVICE_NAME = 'exam-service';
const env = loadServiceEnv(SERVICE_NAME, 'PORT_EXAM_SERVICE');
const prisma = new PrismaClient();

const app = createExamApp({ env, prisma });

listenWithGracefulShutdown(app, env.PORT, SERVICE_NAME, async () => { await prisma.$disconnect(); });

export { app, prisma };
