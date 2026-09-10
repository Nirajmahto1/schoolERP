// ──────────────────────────────────────────────
// School ERP — Student Service (app factory)
//
// Split from index.ts so tests can build the app with an injected Prisma
// client and an explicitly-parsed environment, without binding a port or
// validating the real .env at import time.
//
// Phase 3.1: /auth moved to identity-service — this service is students and
// parents only.
// ──────────────────────────────────────────────

import express, { type Express } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { PrismaClient as ControlPlaneClient } from '@school-erp/control-plane';
import { requireAssertion, stripSpoofableHeaders } from '@school-erp/auth';
import type { ServiceEnv } from '@school-erp/config';
import { buildOpenApiDocument } from '@school-erp/http';
import { studentRoutes } from './routes/student.routes';
import { parentRoutes } from './routes/parent.routes';
import { admissionRoutes } from './routes/admission.routes';
import { importRoutes } from './routes/import.routes';
import { logger } from './utils/logger';

/** MUST equal the gateway route-table audience for this service. */
export const SERVICE_NAME = 'student-service';

export interface StudentAppOptions {
  env: ServiceEnv;
  prisma: PrismaClient;
  /**
   * Unused since Phase 3.1 (login routing lives in identity-service); kept
   * optional so older call sites still compile.
   */
  controlPlane?: ControlPlaneClient;
}

export function createStudentApp({ env, prisma }: StudentAppOptions): Express {
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

  // Published contract (GATE 3).
  const openapi = buildOpenApiDocument({
    title: 'Student Service',
    description: 'Students, guardians, the admissions pipeline, transfer certificates, and bulk import.',
    version: '1.0.0',
    basePath: '/api/v1',
    paths: {
      '/students': {
        get: { summary: 'List students (paginated, branch-scoped)', tags: ['students'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Create a student with guardian + enrollment', tags: ['students'], responses: { '201': { description: 'Created' } } },
      },
      '/students/{id}': {
        get: { summary: 'Get one student', tags: ['students'], responses: { '200': { description: 'OK' }, '404': { description: 'Not found (cross-tenant safe)' } } },
        put: { summary: 'Update a student', tags: ['students'], responses: { '200': { description: 'Updated' } } },
        delete: { summary: 'Soft-delete a student', tags: ['students'], responses: { '200': { description: 'Deleted' } } },
      },
      '/students/import': {
        post: {
          summary: 'Bulk Excel import (?mode=dry-run|commit)', tags: ['import'],
          requestBody: { type: 'object', required: ['file'], properties: { file: { type: 'string', description: 'Base64-encoded .xlsx' } } },
          responses: { '200': { description: 'Dry-run report or commit result' } },
        },
      },
      '/admissions/enquiries': {
        get: { summary: 'List admission enquiries', tags: ['admissions'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Create an enquiry', tags: ['admissions'], responses: { '201': { description: 'Created' } } },
      },
      '/admissions/applications': {
        get: { summary: 'List applications', tags: ['admissions'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Create an application (optionally from an enquiry)', tags: ['admissions'], responses: { '201': { description: 'Created' } } },
      },
      '/admissions/applications/{id}/decision': {
        patch: { summary: 'Decide an application (UNDER_REVIEW/INTERVIEW/APPROVED/REJECTED)', tags: ['admissions'], responses: { '200': { description: 'Decided' } } },
      },
      '/admissions/applications/{id}/admit': {
        post: { summary: 'Convert an APPROVED application into an enrolled student', tags: ['admissions'], responses: { '201': { description: 'Admitted' }, '409': { description: 'Not approved or already admitted' } } },
      },
      '/admissions/tcs': {
        get: { summary: 'List issued transfer certificates', tags: ['tc'], responses: { '200': { description: 'OK' } } },
      },
      '/admissions/tcs/{studentId}': {
        post: { summary: 'Issue a TC: closes the active enrollment, deactivates the student', tags: ['tc'], responses: { '201': { description: 'Issued' }, '409': { description: 'No active enrollment' } } },
      },
      '/parents/...': {
        get: { summary: 'Guardian portal endpoints (see parent.routes.ts)', tags: ['parents'], responses: { '200': { description: 'OK' } } },
      },
    },
  });
  app.get('/openapi.json', (_req, res) => { res.json(openapi); });

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

  // ── Everything requires a gateway-signed, audience-bound assertion.
  //    A request arriving directly on the service port without one gets 401.
  //    (Auth/public routes live on identity-service since Phase 3.1.)
  const assertion = requireAssertion(env.INTERNAL_ASSERTION_PUBLIC_KEY, SERVICE_NAME);
  app.use('/students', assertion, studentRoutes);
  app.use('/parents', assertion, parentRoutes);
  app.use('/admissions', assertion, admissionRoutes);
  app.use('/import', assertion, importRoutes);

  return app;
}