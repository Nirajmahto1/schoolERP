// ──────────────────────────────────────────────
// Service bootstrap
//
// Every downstream service needs the same five things wired in the same order:
// strip spoofable headers, parse JSON, log, expose health, then gate everything
// else behind assertion verification. Doing that inline in each service is how
// one of them ends up missing a step.
// ──────────────────────────────────────────────

import express, { type Express, type RequestHandler } from 'express';
import { requireAssertion, stripSpoofableHeaders } from './middleware';

export interface ServiceAppOptions {
  /** MUST match the `service` value in the gateway route table (the audience). */
  serviceName: string;
  assertionPublicKey: string;
  /** Anything reachable without an assertion. `/health` and `/ready` are automatic. */
  publicPaths?: string[];
  jsonLimit?: string;
  onLog?: (message: string) => void;
  /** Readiness probe — typically a `SELECT 1`. */
  readinessCheck?: () => Promise<void>;
}

export interface ServiceApp {
  app: Express;
  /** Mount protected routers with this: `mount('/staff', staffRoutes)`. */
  mount: (path: string, ...handlers: RequestHandler[]) => void;
  /** Call after all routes are mounted. */
  finalize: () => void;
}

function problemJson(status: number, type: string, title: string, detail: string) {
  return { type, title, status, detail };
}

export function createServiceApp(options: ServiceAppOptions): ServiceApp {
  const {
    serviceName,
    assertionPublicKey,
    jsonLimit = '1mb',
    onLog,
    readinessCheck,
  } = options;

  const app = express();

  app.disable('x-powered-by');

  // First, always: a client must never be able to assert its own identity.
  app.use(stripSpoofableHeaders);

  // Deliberately no CORS: internal services are reachable only via the gateway,
  // which owns the browser-facing policy. Permissive CORS on an internal
  // service invites direct browser calls that skip the gateway entirely.
  app.use(express.json({ limit: jsonLimit }));

  if (onLog) {
    app.use((req, _res, next) => {
      if (req.path !== '/health') onLog(`${req.method} ${req.path}`);
      next();
    });
  }

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: serviceName, timestamp: new Date().toISOString() });
  });

  app.get('/ready', async (_req, res) => {
    if (!readinessCheck) {
      res.json({ status: 'ready', service: serviceName });
      return;
    }
    try {
      await readinessCheck();
      res.json({ status: 'ready', service: serviceName });
    } catch {
      res
        .status(503)
        .json(problemJson(503, 'unavailable', 'Not Ready', 'A dependency is not reachable.'));
    }
  });

  const assertion = requireAssertion(assertionPublicKey, serviceName);

  const mount = (path: string, ...handlers: RequestHandler[]): void => {
    app.use(path, assertion, ...handlers);
  };

  const finalize = (): void => {
    app.use((req, res) => {
      res
        .status(404)
        .json(
          problemJson(
            404,
            'not-found',
            'Not Found',
            `No route matches ${req.method} ${req.path} on ${serviceName}.`,
          ),
        );
    });

    app.use(
      (
        err: Error & { status?: number; type?: string },
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        const status = err.status ?? 500;
        onLog?.(`ERROR ${status}: ${err.message}`);
        res.status(status).json(
          problemJson(
            status,
            err.type ?? 'internal-error',
            status === 500 ? 'Internal Server Error' : 'Request Failed',
            status === 500 && process.env.NODE_ENV === 'production'
              ? 'An unexpected error occurred.'
              : err.message,
          ),
        );
      },
    );
  };

  return { app, mount, finalize };
}

/**
 * Bind a listener with signal handling, so `docker stop` drains in-flight
 * requests rather than severing them mid-transaction.
 */
export function listenWithGracefulShutdown(
  app: Express,
  port: number,
  serviceName: string,
  onShutdown?: () => Promise<void>,
  log: (msg: string) => void = console.log,
): void {
  const server = app.listen(port, () => {
    log(`${serviceName} listening on http://localhost:${port}`);
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log(`${signal} received — draining ${serviceName}`);
      server.close(async () => {
        await onShutdown?.();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10_000).unref();
    });
  }
}
