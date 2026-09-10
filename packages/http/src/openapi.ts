// ──────────────────────────────────────────────
// OpenAPI document builder
//
// Small and dependency-free: services declare their routes once as plain
// objects and get a valid OpenAPI 3.1 document at GET /openapi.json. The
// value is not codegen (yet) — it is a published, drift-checked contract so
// the frontend and mobile app stop guessing at payloads.
// ──────────────────────────────────────────────

export interface OpenApiOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  /** JSON Schema for the request body (OpenAPI 3.1 accepts raw JSON Schema). */
  requestBody?: Record<string, unknown>;
  /** HTTP status → { description, jsonSchema? } */
  responses?: Record<string, { description: string; jsonSchema?: Record<string, unknown> }>;
}

export interface OpenApiPath {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  patch?: OpenApiOperation;
  put?: OpenApiOperation;
  delete?: OpenApiOperation;
}

export interface OpenApiDocumentInput {
  title: string;
  description?: string;
  version: string;
  /** e.g. "/students" — the mount path clients call through the gateway. */
  basePath: string;
  paths: Record<string, OpenApiPath>;
  /** The assertion header every non-public route requires. */
  securitySchemes?: Record<string, unknown>;
}

export function buildOpenApiDocument(input: OpenApiDocumentInput): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const [path, methods] of Object.entries(input.paths)) {
    const full = `${input.basePath}${path}`;
    paths[full] = Object.fromEntries(
      Object.entries(methods).map(([method, op]) => {
        const o = op as OpenApiOperation;
        return [
          method.toLowerCase(),
          {
            summary: o.summary ?? '',
            ...(o.description ? { description: o.description } : {}),
            ...(o.tags ? { tags: o.tags } : {}),
            ...(o.requestBody
              ? { requestBody: { required: true, content: { 'application/json': { schema: o.requestBody } } } }
              : {}),
            responses: Object.fromEntries(
              Object.entries(o.responses ?? { '200': { description: 'OK' } }).map(
                ([status, r]) => [
                  status,
                  {
                    description: r.description,
                    ...(r.jsonSchema
                      ? { content: { 'application/json': { schema: r.jsonSchema } } }
                      : {}),
                  },
                ],
              ),
            ),
          },
        ];
      }),
    );
  }

  const assertionHeader = {
    type: 'apiKey',
    in: 'header',
    name: 'x-internal-assertion',
    description:
      'Gateway-signed, audience-bound RSA assertion (ADR-3). Browsers never send this; the gateway does.',
  };

  return {
    openapi: '3.1.0',
    info: {
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      version: input.version,
    },
    servers: [{ url: '/api/v1', description: 'Via the API gateway' }],
    components: {
      securitySchemes: { internalAssertion: assertionHeader, ...(input.securitySchemes ?? {}) },
    },
    // Everything behind the gateway requires the assertion; public auth
    // routes on identity-service override per-operation.
    security: [{ internalAssertion: [] }],
    paths,
  };
}
