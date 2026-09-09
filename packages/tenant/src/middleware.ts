// ──────────────────────────────────────────────
// Tenant middleware (BUILD_PLAN 1.3.5 on the HTTP surface)
//
// Binds the AsyncLocalStorage tenant context for the duration of every request
// so handlers can call `tenantPrisma(req)` — and so a Prisma call with no
// tenant bound throws instead of silently hitting the wrong database.
//
// The tenant id comes from the gateway-verified assertion (`req.ctx`); the
// slug form (`X-Tenant-Slug`) is the documented mobile fallback resolved
// against the control plane. Unresolved or blocked tenants never reach a
// handler.
// ──────────────────────────────────────────────

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@school-erp/database';
import { NoTenantContextError, currentTenantId, runWithTenant } from './context';
import { TenantRegistry, TenantUnavailableError } from './registry';
import { tenantStatusHttp } from './status';

/** Express request augmentation for the tenant package. */
declare module 'express-serve-static-core' {
  interface Request {
    /** Set by withTenant() once the tenant is resolved and bound. */
    tenant?: { tenantId: string; slug: string };
  }
}

const SLUG_HEADER = 'x-tenant-slug';

export interface WithTenantOptions {
  registry: TenantRegistry;
  /**
   * Dev-only escape hatch: when the assertion carries no tenantId (local
   * scripts, seeded single-tenant dev setups), the request may fall back to
   * this fixed tenant id. NEVER set it in production — there it is a
   * cross-tenant leak waiting to happen, so this middleware refuses to apply
   * it when NODE_ENV=production.
   */
  devFallbackTenantId?: string;
  log?: (message: string) => void;
}

interface AssertionCarrier {
  ctx?: { tenantId?: string };
}

/** Reject with the plan's status mapping for a blocked tenant. */
function rejectBlocked(res: Response, err: TenantUnavailableError & { status: string }): void {
  const http = tenantStatusHttp(err.status as Parameters<typeof tenantStatusHttp>[0]);
  res
    .status(http?.status ?? 403)
    .json(http ?? { status: 403, type: 'tenant-blocked', title: 'Account Unavailable', detail: 'This school account cannot serve requests.' });
}

/**
 * Resolve + bind the tenant for every request that follows.
 *
 * Mount AFTER assertion verification (it reads req.ctx) and BEFORE routes.
 */
export function withTenant(options: WithTenantOptions): RequestHandler {
  const { registry } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const assertion = (req as Request & AssertionCarrier).ctx;
      let tenantId: string | undefined = assertion?.tenantId;
      let slug: string | null = null;

      // Mobile-app fallback: resolve the slug header against the control plane.
      // The assertion, when present, always wins — it is signed, the header is not.
      if (!tenantId) {
        const headerSlug = req.header(SLUG_HEADER);
        if (headerSlug) {
          const record = await registry.resolveBySlug(headerSlug.toLowerCase());
          if (!record) {
            res.status(404).json({
              type: 'tenant-not-found',
              title: 'Unknown School',
              status: 404,
              detail: 'No school matches this request.',
            });
            return;
          }
          tenantId = record.tenantId;
          slug = record.slug;
        }
      }

      // Local-development convenience. Refuses to apply in production, where a
      // misconfigured deploy would silently bind every request to one tenant.
      if (!tenantId && options.devFallbackTenantId && process.env.NODE_ENV !== 'production') {
        options.log?.(`tenant middleware: no assertion tenant, dev fallback ${options.devFallbackTenantId}`);
        const record = await registry.resolveById(options.devFallbackTenantId).catch(() => null);
        req.tenant = { tenantId: options.devFallbackTenantId, slug: record?.slug ?? '' };
        return runWithTenant(options.devFallbackTenantId, () => next());
      }

      if (!tenantId) {
        res.status(400).json({
          type: 'tenant-missing',
          title: 'Tenant Not Identified',
          status: 400,
          detail: 'Requests must identify a school (assertion tenant or X-Tenant-Slug).',
        });
        return;
      }

      try {
        // runWithTenant resolves the tenant, rejects blocked statuses, then
        // binds the AsyncLocalStorage context for everything below.
        await registry.runWithTenant(tenantId, async () => {
          const record = await registry.resolveById(tenantId as string);
          req.tenant = { tenantId, slug: record?.slug ?? slug ?? '' };
          next();
        });
      } catch (err) {
        if (err instanceof TenantUnavailableError) {
          rejectBlocked(res, err as TenantUnavailableError & { status: string });
          return;
        }
        next(err);
      }
    })();
  };
}

/**
 * Translate package errors to problem+json responses. Mount after the router
 * (before any generic error handler) so tenant failures keep their precise
 * 402/423 semantics.
 */
export function tenantErrorHandler(
  err: Error & { status?: number; type?: string },
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof TenantUnavailableError) {
    const http = tenantStatusHttp(err.status);
    if (http) {
      res.status(http.status).json(http);
      return;
    }
  }
  if (err instanceof NoTenantContextError) {
    // Reaching this inside a request means a route escaped its bound context —
    // a programming error, not a client error.
    res.status(500).json({
      type: 'tenant-context-missing',
      title: 'Internal Error',
      status: 500,
      detail: 'Request handling lost its tenant context.',
    });
    return;
  }
  next(err);
}

/** The tenant bound to this request, or null before withTenant ran. */
export function tenantOf(req: Request): { tenantId: string; slug: string } | null {
  return req.tenant ?? null;
}

/**
 * A Prisma client for the CURRENT request's tenant database.
 *
 * Handlers call this instead of touching a shared client; the client comes
 * from the registry's LRU cache and every query it runs belongs to exactly
 * one school. Outside a bound context it throws — the guard the plan demands.
 */
export async function tenantPrisma(req: Request, registry: TenantRegistry): Promise<PrismaClient> {
  const bound = req.tenant;
  if (bound) return registry.getClientFor(bound.tenantId);
  const inContext = currentTenantId();
  if (inContext) return registry.getClientFor(inContext);
  throw new NoTenantContextError();
}
