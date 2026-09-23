// ──────────────────────────────────────────────
// Upstream route table
//
// One declarative list, so "which routes are public?" is answerable by reading
// a single file. Adding a route without an explicit `public: true` means it
// requires authentication — the safe default.
// ──────────────────────────────────────────────

import type { GatewayEnv } from '@school-erp/config';
import type { UpstreamRoute } from './proxy';

export function buildRoutes(env: GatewayEnv): UpstreamRoute[] {
  const serviceHost = (name: string): string =>
    env.UPSTREAM_HOST_STYLE === 'compose'
      ? name
      : env.UPSTREAM_HOST;

  return [
    // ── Public: login / refresh / logout / MFA verify / password reset only ──
    // NOTE: `/auth/register` was removed. It allowed anyone on the internet to
    // create a SUPER_ADMIN for an arbitrary schoolId. User creation is now
    // invite-only and lives behind auth on identity-service.
    {
      path: '/api/v1/auth',
      service: 'identity-service',
      host: serviceHost('identity-service'),
      port: env.PORT_IDENTITY_SERVICE,
      rewriteTo: '/auth',
      public: true,
    },

    // ── Node services ──
    // First-run setup wizard (guarded public): POST /setup is locked by the
    // empty-database guard inside provision-service — it answers only until
    // the first school exists. GET /setup/status powers the page redirect.
    {
      path: '/api/v1/setup',
      service: 'provision-service',
      host: serviceHost('provision-service'),
      port: env.PORT_PROVISION_SERVICE,
      rewriteTo: '/setup',
      public: true,
    },
    // Branch management (gated): add/rename branches after setup, from the
    // dashboard. The assertion mints with the provision-service audience.
    {
      path: '/api/v1/branches',
      service: 'provision-service',
      host: serviceHost('provision-service'),
      port: env.PORT_PROVISION_SERVICE,
      rewriteTo: '/branches',
    },
    {
      path: '/api/v1/dpdp',
      service: 'student-service',
      host: serviceHost('student-service'),
      port: env.PORT_STUDENT_SERVICE,
      rewriteTo: '/dpdp',
    },
    {
      path: '/api/v1/students',
      service: 'student-service',
      host: serviceHost('student-service'),
      port: env.PORT_STUDENT_SERVICE,
      rewriteTo: '/students',
    },
    {
      path: '/api/v1/parents',
      service: 'student-service',
      host: serviceHost('student-service'),
      port: env.PORT_STUDENT_SERVICE,
      rewriteTo: '/parents',
    },
    {
      path: '/api/v1/users',
      service: 'identity-service',
      host: serviceHost('identity-service'),
      port: env.PORT_IDENTITY_SERVICE,
      rewriteTo: '/auth',
    },
    {
      path: '/api/v1/teacher',
      service: 'staff-service',
      host: serviceHost('staff-service'),
      port: env.PORT_STAFF_SERVICE,
      rewriteTo: '/teacher',
    },
    {
      // Staff/student profile photos (authenticated bytes; the DB row stores
      // the relative /photos/file/... URL the apps resolve through here).
      path: '/api/v1/photos',
      service: 'staff-service',
      host: serviceHost('staff-service'),
      port: env.PORT_STAFF_SERVICE,
      rewriteTo: '/photos',
    },
    {
      path: '/api/v1/staff',
      service: 'staff-service',
      host: serviceHost('staff-service'),
      port: env.PORT_STAFF_SERVICE,
      rewriteTo: '/staff',
    },
    {
      path: '/api/v1/admin',
      service: 'staff-service',
      host: serviceHost('staff-service'),
      port: env.PORT_STAFF_SERVICE,
      rewriteTo: '/admin',
    },
    {
      path: '/api/v1/payroll',
      service: 'staff-service',
      host: serviceHost('staff-service'),
      port: env.PORT_STAFF_SERVICE,
      rewriteTo: '/payroll',
    },
    {
      path: '/api/v1/leave-requests',
      service: 'staff-service',
      host: serviceHost('staff-service'),
      port: env.PORT_STAFF_SERVICE,
      rewriteTo: '/leave-requests',
    },
    {
      path: '/api/v1/transport',
      service: 'staff-service',
      host: serviceHost('staff-service'),
      port: env.PORT_STAFF_SERVICE,
      rewriteTo: '/transport',
    },
    {
      path: '/api/v1/academics',
      service: 'academic-service',
      host: serviceHost('academic-service'),
      port: env.PORT_ACADEMIC_SERVICE,
      rewriteTo: '',
    },
    {
      path: '/api/v1/library',
      service: 'academic-service',
      host: serviceHost('academic-service'),
      port: env.PORT_ACADEMIC_SERVICE,
      rewriteTo: '/library',
    },
    // ── Razorpay webhook (BUILD_PLAN 4.1): the provider's servers cannot
    // carry a Bearer token, so this prefix is public. Authenticity is the
    // webhook-secret HMAC, verified at fee-service over the raw body — the
    // proxy must not parse or buffer the request.
    {
      path: '/api/v1/fees/webhooks',
      service: 'fee-service',
      host: serviceHost('fee-service'),
      port: env.PORT_FEE_SERVICE,
      rewriteTo: '/webhooks',
      public: true,
    },
    {
      path: '/api/v1/fees',
      service: 'fee-service',
      host: serviceHost('fee-service'),
      port: env.PORT_FEE_SERVICE,
      rewriteTo: '',
    },
    // ── Provider delivery callbacks (BUILD_PLAN 5.1/5.2): Meta and the SMS
    // aggregators cannot carry a Bearer token, so this prefix is public.
    // Authenticity is the webhook HMAC verified at communication-service over
    // the raw body — same shape as the fee-service Razorpay webhook.
    {
      path: '/api/v1/communication/webhooks',
      service: 'communication-service',
      host: serviceHost('communication-service'),
      port: env.PORT_COMMUNICATION_SERVICE,
      rewriteTo: '/webhooks',
      public: true,
    },
    {
      path: '/api/v1/communication',
      service: 'communication-service',
      host: serviceHost('communication-service'),
      port: env.PORT_COMMUNICATION_SERVICE,
      rewriteTo: '',
      // Class-room chat live delivery (Phase 9): WebSocket upgrades for
      // /api/v1/communication/chat/ws are proxied with the standard auth
      // pipeline applied to the initiating HTTP request.
      ws: true,
    },
    {
      path: '/api/v1/attendance',
      service: 'attendance-service',
      host: serviceHost('attendance-service'),
      port: env.PORT_ATTENDANCE_SERVICE,
      rewriteTo: '/attendance',
    },
    {
      path: '/api/v1/admissions',
      service: 'student-service',
      host: serviceHost('student-service'),
      port: env.PORT_STUDENT_SERVICE,
      rewriteTo: '/admissions',
    },
    {
      path: '/api/v1/exams',
      service: 'exam-service',
      host: serviceHost('exam-service'),
      port: env.PORT_EXAM_SERVICE,
      rewriteTo: '',
    },
    {
      path: '/api/v1/hr',
      service: 'staff-service',
      host: serviceHost('staff-service'),
      port: env.PORT_STAFF_SERVICE,
      rewriteTo: '/hr',
    },

    // ── Python services ──
    // Tokenized scheduled-report downloads. Public BY DESIGN: the 32-byte
    // token in the path IS the credential (hashed at rest, bound to one stored
    // artifact, expiring) and the link arrives by email/WhatsApp, where the
    // reader has no session. Registered before the general `/analytics` prefix
    // so this narrower path is the one that matches.
    {
      path: '/api/v1/analytics/reports/download',
      service: 'analytics-service',
      host: serviceHost('analytics-service'),
      port: env.PORT_ANALYTICS_SERVICE,
      rewriteTo: '/analytics/reports/download',
      public: true,
    },
    {
      path: '/api/v1/analytics',
      service: 'analytics-service',
      host: serviceHost('analytics-service'),
      port: env.PORT_ANALYTICS_SERVICE,
      rewriteTo: '/analytics',
    },
    {
      path: '/api/v1/ai',
      service: 'ai-service',
      host: serviceHost('ai-service'),
      port: env.PORT_AI_SERVICE,
      rewriteTo: '/api/v1/ai',
    },

    // ── Go services ──
    {
      path: '/api/v1/notifications',
      service: 'notification-engine',
      host: serviceHost('notification-engine'),
      port: env.PORT_NOTIFICATION_ENGINE,
      rewriteTo: '/notifications',
      ws: true,
    },
    {
      path: '/api/v1/bulk',
      service: 'bulk-processor',
      host: serviceHost('bulk-processor'),
      port: env.PORT_BULK_PROCESSOR,
      rewriteTo: '/bulk',
    },
    {
      path: '/api/v1/timetable',
      service: 'timetable-engine',
      host: serviceHost('timetable-engine'),
      port: env.PORT_TIMETABLE_ENGINE,
      rewriteTo: '/timetable',
    },
    {
      path: '/api/v1/files',
      service: 'file-service',
      host: serviceHost('file-service'),
      port: env.PORT_FILE_SERVICE,
      rewriteTo: '/files',
    },
  ];
}
