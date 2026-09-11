// ──────────────────────────────────────────────
// School ERP — API Gateway (app factory)
//
// Split from index.ts so tests can build an app without binding a port.
// ──────────────────────────────────────────────

import { randomUUID } from 'crypto';
import express, { type Express } from 'express';
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
import { createUpstreamProxy } from './proxy';
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

  for (const route of routes) {
    const proxy = createUpstreamProxy(route, env.UPSTREAM_TIMEOUT_MS);

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
      app.use(route.path, authenticate, throttle, proxy);
      logger.info(`  ${route.path} → ${route.service}`);
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

  return app;
}
