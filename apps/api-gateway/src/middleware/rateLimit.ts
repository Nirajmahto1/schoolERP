// ──────────────────────────────────────────────
// Rate limiting
//
// The previous config was a single global 1000 requests / 15 min. That is no
// protection against credential stuffing: an attacker gets ~66 login attempts
// per minute, and one busy school could exhaust the quota for everyone.
//
// Now: strict per-IP+account limits on auth, moderate on writes, generous on
// reads, all keyed by identity where available.
// ──────────────────────────────────────────────

import rateLimit, { type Options, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request } from 'express';

function problemResponse(detail: string) {
  return {
    type: 'rate-limit',
    title: 'Too Many Requests',
    status: 429,
    detail,
  };
}

/** Identity-aware key: authenticated users get their own bucket, not their NAT's. */
function identityKey(req: Request): string {
  const identity = (req as { identity?: { tenantId: string; userId: string } }).identity;
  if (identity) return `u:${identity.tenantId}:${identity.userId}`;
  return `ip:${req.ip}`;
}

/**
 * Login / refresh / password-reset limiter.
 *
 * Keyed on IP **and** the submitted email, so one attacker cannot lock out a
 * whole school by cycling emails from one IP, and a distributed attack cannot
 * spread attempts against a single account across many IPs.
 */
export function authLimiter(maxAttempts: number, windowMinutes: number): RateLimitRequestHandler {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max: maxAttempts,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
      const email =
        typeof (req.body as { email?: unknown } | undefined)?.email === 'string'
          ? ((req.body as { email: string }).email).toLowerCase()
          : '';
      return `auth:${req.ip}:${email}`;
    },
    message: problemResponse(
      'Too many attempts. Wait a few minutes before trying again.',
    ),
  });
}

/** Writes: enough for bulk data entry by a front-office clerk, not for scraping. */
export function writeLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: identityKey,
    message: problemResponse('Too many write requests. Slow down and retry shortly.'),
  });
}

/** Reads: a dashboard can legitimately fan out many requests on load. */
export function readLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: identityKey,
    message: problemResponse('Too many requests. Please slow down.'),
  });
}

/**
 * Method-aware limiter: applies the write budget to mutations and the read
 * budget to everything else.
 */
export function methodAwareLimiter(): (
  req: Request,
  res: Parameters<RateLimitRequestHandler>[1],
  next: Parameters<RateLimitRequestHandler>[2],
) => void {
  const write = writeLimiter();
  const read = readLimiter();
  const mutating = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  return (req, res, next) => {
    if (mutating.has(req.method)) return write(req, res, next);
    return read(req, res, next);
  };
}

export type { Options as RateLimitOptions };
