// ──────────────────────────────────────────────
// @school-erp/http — the HTTP layer every service shares (ADR-4)
//
// With 12 services, an error envelope fixed in one place is fixed everywhere.
// This package is deliberately small: request-id correlation, the problem+json
// envelope, health/readiness, and the middleware that binds them together.
// Authentication stays in @school-erp/auth; tenant routing in @school-erp/tenant.
// ──────────────────────────────────────────────

export {
  HttpProblemError,
  problem,
  problemNotFoundThenErrorHandler,
  type ProblemBody,
} from './problem';

export {
  REQUEST_ID_HEADER,
  requestId,
  requestIdOf,
  requestLogger,
} from './request-id';

export {
  healthRoutes,
  prismaPing,
  type ReadinessCheck,
} from './health';

export {
  buildOpenApiDocument,
  type OpenApiDocumentInput,
  type OpenApiOperation,
  type OpenApiPath,
} from './openapi';
