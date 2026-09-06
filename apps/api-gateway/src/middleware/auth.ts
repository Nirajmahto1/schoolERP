// ──────────────────────────────────────────────
// Gateway authentication
//
// Verifies the end user's access token (including denylist / revocation), then
// attaches a minter that produces a short-lived signed assertion per upstream
// hop. See ADR-3 in docs/BUILD_PLAN.md.
//
// The previous implementation copied JWT claims into `x-user-*` headers and
// trusted downstream services to believe them. Those headers are now stripped
// on the way in and never set on the way out.
// ──────────────────────────────────────────────

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  TokenError,
  mintAssertion,
  verifyAccessToken,
  type AssertionSigner,
  type TokenConfig,
  type TokenStore,
} from '@school-erp/auth';

export interface GatewayIdentity {
  userId: string;
  email: string;
  tenantId: string;
  branchId: string | null;
  roles: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      identity?: GatewayIdentity;
      /** Mint an assertion scoped to one upstream service. */
      mintFor?: (audience: string) => string;
    }
  }
}

function problem(
  res: Response,
  status: number,
  type: string,
  title: string,
  detail: string,
): void {
  res.status(status).type('application/problem+json').json({ type, title, status, detail });
}

export interface AuthMiddlewareDeps {
  tokens: TokenConfig;
  store: TokenStore;
  signer: AssertionSigner;
}

export function createAuthMiddleware(deps: AuthMiddlewareDeps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
      problem(
        res,
        401,
        'authentication-error',
        'Unauthorized',
        'Missing or invalid authorization header. Expected: Bearer <token>',
      );
      return;
    }

    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      problem(res, 401, 'authentication-error', 'Unauthorized', 'Bearer token is empty.');
      return;
    }

    try {
      const claims = await verifyAccessToken(token, deps.tokens, deps.store);

      const identity: GatewayIdentity = {
        userId: claims.sub,
        email: claims.email,
        tenantId: claims.tenantId,
        branchId: claims.branchId,
        roles: claims.roles,
      };
      req.identity = identity;

      // A fresh assertion per upstream, audience-bound so an assertion minted
      // for fee-service cannot be replayed against staff-service.
      req.mintFor = (audience: string) =>
        mintAssertion(
          {
            userId: identity.userId,
            email: identity.email,
            tenantId: identity.tenantId,
            branchId: identity.branchId,
            roles: identity.roles,
            audience,
          },
          deps.signer,
        );

      next();
    } catch (err) {
      if (err instanceof TokenError) {
        const detail =
          err.reason === 'expired'
            ? 'Your session has expired. Refresh your token and retry.'
            : err.reason === 'revoked'
              ? 'This session has been signed out.'
              : 'The provided token is invalid.';
        problem(res, 401, 'authentication-error', 'Unauthorized', detail);
        return;
      }
      next(err);
    }
  };
}

/** Coarse role gate at the edge. Services re-check; this fails fast and cheap. */
export function authorize(...roles: string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.identity) {
      problem(res, 401, 'authentication-error', 'Unauthorized', 'Authentication required.');
      return;
    }
    if (!req.identity.roles.some((r) => roles.includes(r))) {
      problem(
        res,
        403,
        'authorization-error',
        'Forbidden',
        'You do not have permission to access this resource.',
      );
      return;
    }
    next();
  };
}
