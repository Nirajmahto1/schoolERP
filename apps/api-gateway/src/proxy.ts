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
import { TENANT_SLUG_HEADER } from './middleware/tenant';
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
  /** Mounted instances pass ws:false — upgrade dispatch goes through the
   *  dedicated handler below, so the proxy must never self-subscribe to the
   *  server's 'upgrade' event (double handling corrupts the socket). */
  opts: { ws?: boolean } = {},
): RequestHandler {
  const target = `http://${route.host}:${route.port}`;

  const options: Options = {
    target,
    changeOrigin: true,
    ws: opts.ws ?? false,
    proxyTimeout: timeoutMs,
    timeout: timeoutMs,
    // NOTE: http-proxy pipes the raw request stream. NO middleware before the
    // proxy may consume that stream (express.json etc.) — a parsed body cannot
    // be re-piped and the upstream hangs forever. Public /auth routes parse
    // their bodies at identity-service, not at the gateway.
    pathRewrite: (path) => {
      const [pathname, query] = path.split('?');
      const suffix = pathname === '/' ? '' : pathname;
      const rewritten = `${route.rewriteTo}${suffix}`.replace(/\/{2,}/g, '/');
      return query ? `${rewritten}?${query}` : rewritten;
    },
    on: {
      proxyReq: (proxyReq, req) => {
        // Belt and braces: the client's copies were stripped at the edge, but
        // ensure nothing re-added them before this hop. The assertion is
        // replaced (not appended) below — removing it first guarantees a
        // client-supplied copy can never survive.
        proxyReq.removeHeader(INTERNAL_ASSERTION_HEADER);
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

        // Forward the resolved tenant hint (see middleware/tenant.ts). The
        // client's copy was stripped at the edge and re-set only when the
        // gateway itself resolved it.
        const tenantSlug = req.headers[TENANT_SLUG_HEADER];
        if (typeof tenantSlug === 'string' && tenantSlug) {
          proxyReq.setHeader(TENANT_SLUG_HEADER, tenantSlug);
        }
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

/**
 * Dedicated upgrade dispatcher for ws-enabled upstreams. This instance is
 * NEVER mounted in the middleware chain (so it never lazily self-subscribes);
 * the entrypoint attaches the returned handler to the HTTP server, giving
 * exactly one 'upgrade' listener per ws route.
 */
export function createUpstreamUpgradeHandler(
  route: UpstreamRoute,
  timeoutMs: number,
): (req: import('http').IncomingMessage, socket: import('net').Socket, head: Buffer) => void {
  const proxy = createUpstreamProxy(route, timeoutMs, { ws: false });
  const upgrade = (proxy as unknown as { upgrade?: unknown }).upgrade;
  if (typeof upgrade !== 'function') {
    throw new Error('http-proxy-middleware did not expose an upgrade handler');
  }
  return upgrade as (req: import('http').IncomingMessage, socket: import('net').Socket, head: Buffer) => void;
}
