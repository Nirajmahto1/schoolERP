// ──────────────────────────────────────────────
// Express middleware — assertion enforcement, header stripping, RBAC
// ──────────────────────────────────────────────

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  AssertionError,
  INTERNAL_ASSERTION_HEADER,
  SPOOFABLE_IDENTITY_HEADERS,
  type RequestContext,
  verifyAssertion,
} from './assertion';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Verified identity. Populated only by `requireAssertion`. */
      ctx?: RequestContext;
    }
  }
}

/** RFC 7807-style error body, matching the existing convention in the codebase. */
function problem(
  res: Response,
  status: number,
  type: string,
  title: string,
  detail: string,
): void {
  res.status(status).type('application/problem+json').json({ type, title, status, detail });
}

/**
 * Strip client-supplied identity headers.
 *
 * MUST be mounted first, on every route including public ones. Without this a
 * client can send `x-user-role: SUPER_ADMIN` and, if any code path ever reads a
 * header instead of `req.ctx`, that value is believed.
 */
export const stripSpoofableHeaders: RequestHandler = (req, _res, next) => {
  for (const header of SPOOFABLE_IDENTITY_HEADERS) {
    delete req.headers[header];
  }
  next();
};

/**
 * Require a valid internal assertion. Mount on every non-public route of every
 * downstream service.
 *
 * `serviceName` must be the service's own name and must match the audience the
 * gateway minted for.
 */
export function requireAssertion(publicKey: string, serviceName: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Read from a local, not req.headers: stripSpoofableHeaders removes the
    // client's copy, and the gateway's proxy sets its own on the outbound hop.
    const token = req.header(INTERNAL_ASSERTION_HEADER);

    try {
      req.ctx = verifyAssertion(token, publicKey, serviceName);
      next();
    } catch (err) {
      if (err instanceof AssertionError) {
        // Deliberately vague to the caller; the reason is logged, not returned.
        problem(
          res,
          401,
          'authentication-error',
          'Unauthorized',
          'This endpoint requires a valid gateway-issued assertion.',
        );
        return;
      }
      next(err);
    }
  };
}

/** Read the verified context, or throw. Use inside handlers instead of headers. */
export function ctx(req: Request): RequestContext {
  if (!req.ctx) {
    throw new Error(
      'req.ctx is not set — requireAssertion() must be mounted before this handler.',
    );
  }
  return req.ctx;
}

/**
 * Role gate. Passes if the user holds ANY of the listed roles.
 *
 * Note this is a coarse check retained for compatibility with existing routes;
 * Phase 2.1 replaces role strings with resolved permissions, at which point
 * `requirePermission` becomes the primary gate.
 */
export function requireRole(...roles: string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const context = req.ctx;
    if (!context) {
      problem(
        res,
        401,
        'authentication-error',
        'Unauthorized',
        'Authentication required.',
      );
      return;
    }

    if (!context.roles.some((r) => roles.includes(r))) {
      problem(
        res,
        403,
        'authorization-error',
        'Forbidden',
        'You do not have permission to perform this action.',
      );
      return;
    }

    next();
  };
}

/** Permission gate on `module.action` strings. */
export function requirePermission(...required: string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const context = req.ctx;
    if (!context) {
      problem(res, 401, 'authentication-error', 'Unauthorized', 'Authentication required.');
      return;
    }

    const held = new Set(context.permissions);
    const missing = required.filter((p) => !held.has(p));
    if (missing.length > 0) {
      problem(
        res,
        403,
        'authorization-error',
        'Forbidden',
        'You do not have permission to perform this action.',
      );
      return;
    }

    next();
  };
}

/**
 * Guard against a query that is not scoped to the caller's tenant.
 *
 * Cross-tenant leakage is the #1 threat for a multi-tenant ERP. Returning 404
 * rather than 403 is intentional: a 403 confirms the resource exists, which is
 * itself a disclosure across a tenant boundary.
 */
export function assertSameTenant(req: Request, resourceTenantId: string | null | undefined): void {
  const context = ctx(req);
  if (!resourceTenantId || resourceTenantId !== context.tenantId) {
    const err = new Error('Resource not found.') as Error & { status?: number; type?: string };
    err.status = 404;
    err.type = 'not-found';
    throw err;
  }
}
