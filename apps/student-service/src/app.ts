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
import { buildOpenApiDocument, jsonRequestLogger, metricsMiddleware } from '@school-erp/http';
import { studentRoutes } from './routes/student.routes';
import { parentRoutes } from './routes/parent.routes';
import { admissionRoutes } from './routes/admission.routes';
import { certificateRoutes } from './routes/certificate.routes';
import { dpdpRoutes } from './routes/dpdp.routes';
import { governmentRoutes } from './routes/government.routes';
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
      '/students/{studentId}/certificates': {
        get: { summary: "List a student's certificates (staff, or the owning student/parent)", tags: ['certificates'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Issue a certificate (BONAFIDE/CHARACTER/FEE_CERTIFICATE/ID_CARD/ADMIT_CARD)', tags: ['certificates'], responses: { '201': { description: 'Issued' }, '409': { description: 'No exam schedule for an admit card' } } },
      },
      '/students/{studentId}/certificates/{certId}/pdf': {
        get: { summary: 'Download the certificate PDF (renders from the issue-time snapshot)', tags: ['certificates'], responses: { '200': { description: 'PDF' }, '404': { description: 'Not found' } } },
      },
      '/admissions/tcs/{tcId}/pdf': {
        get: { summary: 'Download a transfer certificate as the CBSE-style ruled PDF', tags: ['tc'], responses: { '200': { description: 'PDF' } } },
      },
      '/dpdp/{studentId}/consent': {
        get: { summary: 'Consent ledger for one child (DPDP §10.1)', tags: ['dpdp'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Grant verifiable parental consent for one purpose', tags: ['dpdp'], responses: { '201': { description: 'Granted' } } },
      },
      '/dpdp/{studentId}/consent/{purpose}/withdraw': {
        post: { summary: 'Withdraw consent (the DPDP withdrawal path)', tags: ['dpdp'], responses: { '200': { description: 'Withdrawn' } } },
      },
      '/dpdp/{studentId}/data-export': {
        get: { summary: 'Full data export for one child (DPDP access right)', tags: ['dpdp'], responses: { '200': { description: 'JSON export' } } },
      },
      '/dpdp/{studentId}/erasure-requests': {
        post: { summary: 'File an erasure request (DPDP erasure right)', tags: ['dpdp'], responses: { '201': { description: 'Filed' } } },
      },
      '/dpdp/erasure-requests': {
        get: { summary: 'Erasure inbox for the grievance officer', tags: ['dpdp'], responses: { '200': { description: 'OK' } } },
      },
      '/dpdp/erasure-requests/{id}/process': {
        post: { summary: 'Complete or reject an erasure request (audited, retention-aware)', tags: ['dpdp'], responses: { '200': { description: 'Processed' } } },
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
  //
  //    importRoutes declares its full path (router.post('/students/import')),
  //    so it must be mounted WITHOUT a path prefix — any prefix would be
  //    stripped and the route would never match. It was previously mounted at
  //    /import (and briefly /students/import), which is why the endpoint 404ed
  //    through the gateway and the Phase-8.5 UI could never reach the
  //    Phase-3.2 backend. Mounted last: only requests the specific routers
  //    above did not handle fall through to the assertion + import routes.
  const assertion = requireAssertion(env.INTERNAL_ASSERTION_PUBLIC_KEY, SERVICE_NAME);
  // Government routes BEFORE studentRoutes: /students/government/* would
  // otherwise be swallowed by studentRoutes' GET /:id ("government" parsed
  // as an id → CastError → 500).
  app.use('/students', assertion, governmentRoutes);
  app.use('/students', assertion, studentRoutes);
  app.use('/students', assertion, certificateRoutes);
  app.use('/parents', assertion, parentRoutes);
  // Also mounted under /admissions so the TC PDF downloads from the same
  // prefix that issues the TC (GET /admissions/tcs/:tcId/pdf).
  app.use('/admissions', assertion, admissionRoutes);
  app.use('/admissions', assertion, certificateRoutes);
  app.use('/dpdp', assertion, dpdpRoutes);
  app.use(assertion, importRoutes);

  return app;
}