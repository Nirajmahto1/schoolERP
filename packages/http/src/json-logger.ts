// ──────────────────────────────────────────────
// Structured JSON request log (Phase 11.1)
//
// One JSON object per request: ts, level, service, method, path, status,
// duration_ms, request_id, tenant_id, user_id, branch_id. The identity
// fields arrive from the gateway's verified-assertion headers (never raw
// client input — stripSpoofableHeaders has already run), so a log line can
// be traced end-to-end and sliced per tenant in any log sink.
//
// Log-based alerts (error rate, p99) parse exactly this shape.
// ──────────────────────────────────────────────

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { requestIdOf } from './request-id';

export interface JsonLoggerOptions {
  service: string;
  /** Emit only >=warn for non-5xx to keep noise down. Default false. */
  quiet2xx?: boolean;
}

function jsonLog(entry: Record<string, unknown>): void {
  // Single write, no pretty-printing — a log sink ingests one line per event.
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

export function jsonRequestLogger(options: JsonLoggerOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const status = res.statusCode;
      if (options.quiet2xx && status < 400) return;
      const authed = (req as Request & { assertion?: { tenantId?: string; userId?: string; branchId?: string } })
        .assertion;
      jsonLog({
        ts: new Date().toISOString(),
        level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
        service: options.service,
        msg: 'request',
        method: req.method,
        path: req.originalUrl,
        status,
        duration_ms: Number(ms.toFixed(1)),
        request_id: requestIdOf(req),
        tenant_id: authed?.tenantId ?? null,
        branch_id: authed?.branchId ?? null,
        user_id: authed?.userId ?? null,
      });
    });
    next();
  };
}

export { jsonLog };
