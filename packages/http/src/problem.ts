// ──────────────────────────────────────────────
// RFC 7807 problem+json envelope
//
// Every error, on every service, in the same shape. A client that learns one
// service's error format has learned them all; a support engineer reading a
// log sees the same fields regardless of which service produced them.
// ──────────────────────────────────────────────

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  /** Correlates with the `x-request-id` response header and gateway logs. */
  requestId?: string;
  [extra: string]: unknown;
}

/** Send an RFC 7807 problem response with the request ID attached. */
export function problem(
  res: Response,
  status: number,
  type: string,
  title: string,
  detail: string,
  extra?: Record<string, unknown>,
): void {
  const body: ProblemBody = { type, title, status, detail, ...extra };
  const requestId = res.getHeader('x-request-id');
  if (typeof requestId === 'string') body.requestId = requestId;
  res.status(status).type('application/problem+json').json(body);
}

/** A plain Error carrying an HTTP status — thrown by handlers, caught centrally. */
export class HttpProblemError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
    detail: string,
  ) {
    super(detail);
    this.name = 'HttpProblemError';
  }
}

/**
 * Mount once, LAST, after every router. Returns two handlers:
 *   1. a 404 closer for unmatched routes (problem-formatted, not Express HTML)
 *   2. the error handler, turning thrown `HttpProblemError`s and unhandled
 *      errors into the standard envelope.
 *
 * 500 details are hidden behind a generic message in production; the reason
 * goes to the log instead.
 */
export function problemNotFoundThenErrorHandler(
  onLog?: (message: string) => void,
): [RequestHandler, (err: Error & { status?: number; type?: string }, req: Request, res: Response, next: NextFunction) => void] {
  const notFound: RequestHandler = (req, res) => {
    problem(res, 404, 'not-found', 'Not Found', `No route matches ${req.method} ${req.path}.`);
  };

  const errorHandler = (
    err: Error & { status?: number; type?: string },
    _req: Request,
    res: Response,
    _next: NextFunction,
  ): void => {
    const status = typeof err.status === 'number' ? err.status : 500;
    const type = err.type ?? 'internal-error';
    const title = err instanceof HttpProblemError ? err.title : status === 500 ? 'Internal Server Error' : 'Request Failed';
    const detail =
      status === 500 && process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred.'
        : err.message;
    if (status >= 500) onLog?.(`ERROR ${status}: ${err.message}`);
    problem(res, status, type, title, detail);
  };

  return [notFound, errorHandler];
}
