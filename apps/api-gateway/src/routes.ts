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
  const host = env.UPSTREAM_HOST;

  return [
    // ── Public: login / refresh / logout / MFA verify / password reset only ──
    // NOTE: `/auth/register` was removed. It allowed anyone on the internet to
    // create a SUPER_ADMIN for an arbitrary schoolId. User creation is now
    // invite-only and lives behind auth on identity-service.
    {
      path: '/api/v1/auth',
      service: 'identity-service',
      host,
      port: env.PORT_IDENTITY_SERVICE,
      rewriteTo: '/auth',
      public: true,
    },

    // ── Node services ──
    {
      path: '/api/v1/students',
      service: 'student-service',
      host,
      port: env.PORT_STUDENT_SERVICE,
      rewriteTo: '/students',
    },
    {
      path: '/api/v1/parents',
      service: 'student-service',
      host,
      port: env.PORT_STUDENT_SERVICE,
      rewriteTo: '/parents',
    },
    {
      path: '/api/v1/users',
      service: 'identity-service',
      host,
      port: env.PORT_IDENTITY_SERVICE,
      rewriteTo: '/auth',
    },
    {
      path: '/api/v1/teacher',
      service: 'staff-service',
      host,
      port: env.PORT_STAFF_SERVICE,
      rewriteTo: '/teacher',
    },
    {
      path: '/api/v1/staff',
      service: 'staff-service',
      host,
      port: env.PORT_STAFF_SERVICE,
      rewriteTo: '/staff',
    },
    {
      path: '/api/v1/admin',
      service: 'staff-service',
      host,
      port: env.PORT_STAFF_SERVICE,
      rewriteTo: '/admin',
    },
    {
      path: '/api/v1/payroll',
      service: 'staff-service',
      host,
      port: env.PORT_STAFF_SERVICE,
      rewriteTo: '/payroll',
    },
    {
      path: '/api/v1/leave-requests',
      service: 'staff-service',
      host,
      port: env.PORT_STAFF_SERVICE,
      rewriteTo: '/leave-requests',
    },
    {
      path: '/api/v1/transport',
      service: 'staff-service',
      host,
      port: env.PORT_STAFF_SERVICE,
      rewriteTo: '/transport',
    },
    {
      path: '/api/v1/academics',
      service: 'academic-service',
      host,
      port: env.PORT_ACADEMIC_SERVICE,
      rewriteTo: '',
    },
    {
      path: '/api/v1/library',
      service: 'academic-service',
      host,
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
      host,
      port: env.PORT_FEE_SERVICE,
      rewriteTo: '/webhooks',
      public: true,
    },
    {
      path: '/api/v1/fees',
      service: 'fee-service',
      host,
      port: env.PORT_FEE_SERVICE,
      rewriteTo: '',
    },
    {
      path: '/api/v1/communication',
      service: 'communication-service',
      host,
      port: env.PORT_COMMUNICATION_SERVICE,
      rewriteTo: '',
    },
    {
      path: '/api/v1/attendance',
      service: 'attendance-service',
      host,
      port: env.PORT_ATTENDANCE_SERVICE,
      rewriteTo: '/attendance',
    },
    {
      path: '/api/v1/admissions',
      service: 'student-service',
      host,
      port: env.PORT_STUDENT_SERVICE,
      rewriteTo: '/admissions',
    },
    {
      path: '/api/v1/exams',
      service: 'exam-service',
      host,
      port: env.PORT_EXAM_SERVICE,
      rewriteTo: '',
    },
    {
      path: '/api/v1/hr',
      service: 'staff-service',
      host,
      port: env.PORT_STAFF_SERVICE,
      rewriteTo: '/hr',
    },

    // ── Python services ──
    {
      path: '/api/v1/analytics',
      service: 'analytics-service',
      host,
      port: env.PORT_ANALYTICS_SERVICE,
      rewriteTo: '/analytics',
    },
    {
      path: '/api/v1/ai',
      service: 'ai-service',
      host,
      port: env.PORT_AI_SERVICE,
      rewriteTo: '/api/v1/ai',
    },

    // ── Go services ──
    {
      path: '/api/v1/notifications',
      service: 'notification-engine',
      host,
      port: env.PORT_NOTIFICATION_ENGINE,
      rewriteTo: '/notifications',
      ws: true,
    },
    {
      path: '/api/v1/bulk',
      service: 'bulk-processor',
      host,
      port: env.PORT_BULK_PROCESSOR,
      rewriteTo: '/bulk',
    },
    {
      path: '/api/v1/timetable',
      service: 'timetable-engine',
      host,
      port: env.PORT_TIMETABLE_ENGINE,
      rewriteTo: '/timetable',
    },
    {
      path: '/api/v1/files',
      service: 'file-service',
      host,
      port: env.PORT_FILE_SERVICE,
      rewriteTo: '/files',
    },
    {
      path: '/api/v1/go',
      service: 'go-service',
      host,
      port: env.PORT_GO_SERVICE,
      rewriteTo: '/api/v1',
    },
  ];
}
