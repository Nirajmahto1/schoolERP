// ──────────────────────────────────────────────
// Proxy factory
//
// Every upstream hop gets a freshly-minted, audience-bound assertion injected
// as `x-internal-assertion`. Routes are declared in one table so it is possible
// to audit at a glance which paths are public and which service owns them —
// the previous version repeated 20 near-identical proxy blocks inline.
// ──────────────────────────────────────────────

import type { RequestHandler } from 'express';
import { createProxyMiddleware, type Options } from 'http-proxy-middleware';
import { INTERNAL_ASSERTION_HEADER } from '@school-erp/auth';
import { logger } from './utils/logger';

export interface UpstreamRoute {
  /** Mount path, e.g. `/api/v1/students`. */
  path: string;
  /** Audience name — MUST equal the service's own `SERVICE_NAME`. */
  service: string;
  host: string;
  port: number;
  /** Path prefix on the upstream, e.g. `/students`. */
  rewriteTo: string;
  /** Public routes skip auth. Only `/auth` and `/health` qualify. */
  public?: boolean;
  /** Upgrade support for WebSocket upstreams. */
  ws?: boolean;
}

export function createUpstreamProxy(
  route: UpstreamRoute,
  timeoutMs: number,
): RequestHandler {
  const target = `http://${route.host}:${route.port}`;

  const options: Options = {
    target,
    changeOrigin: true,
    ws: route.ws ?? false,
    proxyTimeout: timeoutMs,
    timeout: timeoutMs,
    pathRewrite: (path) => {
      const [pathname, query] = path.split('?');
      const suffix = pathname === '/' ? '' : pathname;
      const rewritten = `${route.rewriteTo}${suffix}`.replace(/\/{2,}/g, '/');
      return query ? `${rewritten}?${query}` : rewritten;
    },
    on: {
      proxyReq: (proxyReq, req) => {
        // Belt and braces: the client's copies were stripped at the edge, but
        // ensure nothing re-added them before this hop.
        proxyReq.removeHeader('x-user-id');
        proxyReq.removeHeader('x-user-email');
        proxyReq.removeHeader('x-user-role');
        proxyReq.removeHeader('x-branch-id');
        proxyReq.removeHeader('x-school-id');
        proxyReq.removeHeader('x-tenant-id');

        const mint = (req as { mintFor?: (aud: string) => string }).mintFor;
        if (mint) {
          proxyReq.setHeader(INTERNAL_ASSERTION_HEADER, mint(route.service));
        }

        const requestId = (req as { id?: string }).id;
        if (requestId) proxyReq.setHeader('x-request-id', requestId);
      },
      error: (err, req, res) => {
        logger.error(
          `Upstream ${route.service} (${target}) failed for ${req.method} ${req.url}: ${err.message}`,
        );
        // `res` is ServerResponse for HTTP, Socket for WS upgrades.
        if ('writeHead' in res && !res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/problem+json' });
          res.end(
            JSON.stringify({
              type: 'upstream-error',
              title: 'Service Unavailable',
              status: 502,
              detail: `The ${route.service} service is not responding. Please retry shortly.`,
            }),
          );
        }
      },
    },
  };

  return createProxyMiddleware(options);
}
