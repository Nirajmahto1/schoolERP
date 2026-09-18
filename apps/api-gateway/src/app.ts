// ──────────────────────────────────────────────
// School ERP — API Gateway (app factory)
//
// Split from index.ts so tests can build an app without binding a port.
// ──────────────────────────────────────────────

import { randomUUID } from 'crypto';
import express, { type Express, type RequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import {
  MemoryTokenStore,
  stripSpoofableHeaders,
  type AssertionSigner,
  type TokenConfig,
  type TokenStore,
} from '@school-erp/auth';
import type { GatewayEnv } from '@school-erp/config';
import { createAuthMiddleware, createOptionalAuthMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { authLimiter, ipAuthLimiter, methodAwareLimiter } from './middleware/rateLimit';
import { createTenantHintResolver, TENANT_SLUG_HEADER } from './middleware/tenant';
import { createUpstreamProxy, createUpstreamUpgradeHandler } from './proxy';
import { buildRoutes } from './routes';
import { logger } from './utils/logger';

export interface BuildAppOptions {
  env: GatewayEnv;
  /** Defaults to in-memory; production passes a RedisTokenStore. */
  store?: TokenStore;
}

export function buildApp({ env, store }: BuildAppOptions): Express {
  const app = express();
  const tokenStore = store ?? new MemoryTokenStore();

  const tokens: TokenConfig = {
    accessSecret: env.JWT_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessExpiresIn: env.JWT_EXPIRES_IN,
    refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
  };

  const signer: AssertionSigner = {
    privateKey: env.INTERNAL_ASSERTION_PRIVATE_KEY,
    ttlSeconds: env.INTERNAL_ASSERTION_TTL_SECONDS,
  };

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind ALB/nginx — required for correct req.ip

  // ── MUST be first: drop any client-supplied identity headers ──
  app.use(stripSpoofableHeaders);

  // ── Request ID for cross-service tracing ──
  app.use((req, res, next) => {
    const id = req.header('x-request-id') ?? randomUUID();
    (req as { id?: string }).id = id;
    res.setHeader('x-request-id', id);
    next();
  });

  app.use(
    helmet({
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      contentSecurityPolicy: false, // set by the Next.js app, not the API
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // Explicit allowlist. `origin: true` reflected any origin while sending
  // credentials, which lets any website make authenticated calls on behalf of
  // a logged-in user.
  const allowed = new Set(env.CORS_ALLOWED_ORIGINS);
  app.use(
    cors({
      origin: (origin, callback) => {
        // Same-origin/server-to-server requests send no Origin header.
        if (!origin) return callback(null, true);
        if (allowed.has(origin)) return callback(null, true);
        logger.warn(`Blocked CORS request from disallowed origin: ${origin}`);
        return callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'X-Tenant-Slug'],
      maxAge: 600,
    }),
  );

  app.use(
    morgan('combined', {
      stream: { write: (msg: string) => logger.info(msg.trim()) },
      skip: (req) => req.path === '/health',
    }),
  );

  // Tenant hint: resolve subdomain / mobile slug header BEFORE the proxy so
  // every downstream hop (public /auth included) knows which school this is.
  app.use(createTenantHintResolver(env.TENANT_BASE_DOMAIN));

  // Body is intentionally NOT parsed globally: http-proxy-middleware needs the
  // raw stream, and parsing first makes proxied POSTs hang. The auth limiter
  // needs `req.body.email`, so /api/v1/auth gets a local JSON parser below.

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'api-gateway', timestamp: new Date().toISOString() });
  });

  app.get('/ready', (_req, res) => {
    res.json({ status: 'ready', service: 'api-gateway' });
  });

  const authenticate = createAuthMiddleware({ tokens, store: tokenStore, signer });
  const optionalAuthenticate = createOptionalAuthMiddleware({ tokens, store: tokenStore, signer });
  const throttle = methodAwareLimiter();
  const loginThrottle = authLimiter(5, 15); // body-aware variant (kept for non-proxied use)
  const ipLoginThrottle = ipAuthLimiter(20, 15);
  const routes = buildRoutes(env);

  // WebSocket upgrade dispatch: ws-enabled upstreams get a dedicated,
  // never-mounted upgrade handler (see proxy.ts). The entrypoint attaches
  // the single dispatcher below to the HTTP server; it routes by public
  // prefix — without this, the first-attached handler would claim upgrades
  // belonging to another service.
  const wsRoutes: Array<{
    path: string;
    handler: (req: import('http').IncomingMessage, socket: import('net').Socket, head: Buffer) => void;
  }> = [];

  for (const route of routes) {
    // Mounted proxy instances NEVER self-subscribe to 'upgrade' (ws:false):
    // a lazily-added second listener races the dedicated handler and corrupts
    // WebSocket streams. Upgrades are dispatched solely via the dedicated
    // handler attached by the entrypoint.
    const proxy = createUpstreamProxy(route, env.UPSTREAM_TIMEOUT_MS, { ws: false });

    if (route.public) {
      // Optional auth: a valid Bearer on a public prefix still gets an
      // assertion, so identity-service's gated /auth/me works through the
      // gateway while login/refresh stay anonymous.
      //
      // NO body parser here. http-proxy pipes the raw request stream to the
      // upstream; express.json consumes that stream, and a parsed body cannot
      // be re-piped — the upstream then hangs forever waiting for the
      // announced Content-Length (observed: every proxied POST hangs). The
      // login limiter below therefore keys on IP only (still per-account at
      // identity-service, which parses the body itself).
      app.use(route.path, optionalAuthenticate, ipLoginThrottle, proxy);
      logger.info(`  ${route.path} → ${route.service} (public)`);
    } else {
      // Live-delivery upstreams (chat hub) authenticate WebSocket upgrades
      // with a short-lived ticket in the query string — a WS client cannot
      // send an Authorization header, and a long-lived token in a URL leaks
      // into logs. So upgrades bypass the Bearer gate here; the downstream
      // ticket check (signed, 60s, minted only behind full auth) is the real
      // credential. Every normal HTTP call on this prefix still requires it.
      const auth: RequestHandler = (rq, rs, nx) => {
        if (String(rq.headers.upgrade ?? '').toLowerCase() === 'websocket') return nx();
        return authenticate(rq, rs, nx);
      };
      app.use(route.path, auth, throttle, proxy);
      logger.info(`  ${route.path} → ${route.service}${route.ws ? ' (ws)' : ''}`);
    }
  }

  app.use((req, res) => {
    res.status(404).type('application/problem+json').json({
      type: 'not-found',
      title: 'Not Found',
      status: 404,
      detail: `No route matches ${req.method} ${req.path}.`,
    });
  });

  app.use(errorHandler);

  // Dedicated upgrade handlers for ws-enabled upstreams, built on the SAME
  // target/rewrite as the mounted proxies but never self-subscribed.
  for (const route of routes.filter((r) => r.ws)) {
    wsRoutes.push({ path: route.path, handler: createUpstreamUpgradeHandler(route, env.UPSTREAM_TIMEOUT_MS) });
  }

  const wsUpgradeDispatcher = (req: import('http').IncomingMessage, socket: import('net').Socket, head: Buffer): void => {
    const pathname = (req.url ?? '/').split('?')[0];
    for (const r of wsRoutes) {
      if (pathname === r.path || pathname.startsWith(`${r.path}/`)) {
        r.handler(req, socket, head);
        return;
      }
    }
    socket.destroy();
  };
  (app as unknown as { wsUpgradeDispatcher: typeof wsUpgradeDispatcher }).wsUpgradeDispatcher = wsUpgradeDispatcher;

  return app;
}
