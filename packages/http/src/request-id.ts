// ──────────────────────────────────────────────
// Request ID middleware
//
// Every request gets one correlation id, honoured if the caller (the gateway)
// already supplied one. It rides the response header, every problem+json body,
// and (with withRequestIdLogger) every log line — the thread you pull when one
// user's request touched five services.
// ──────────────────────────────────────────────

import { randomUUID } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Attach an id to the request early; mount before anything that logs. */
export function requestId(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header(REQUEST_ID_HEADER);
    const id = incoming && incoming.length <= 128 ? incoming : randomUUID();
    (req as Request & { id?: string }).id = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}

/** The current request's id, or null outside the middleware's reach. */
export function requestIdOf(req: Request): string | null {
  return (req as Request & { id?: string }).id ?? null;
}

/** One log line per request with method, path, status, duration and request id. */
export function requestLogger(log: (message: string) => void): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      log(
        `${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms [${requestIdOf(req) ?? '-'}]`,
      );
    });
    next();
  };
}
