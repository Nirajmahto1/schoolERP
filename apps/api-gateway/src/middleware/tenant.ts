// ──────────────────────────────────────────────
// Gateway tenant-hint resolution (BUILD_PLAN 1.3.1)
//
// The tenant is known BEFORE login, from the hostname the request arrived on:
// `dps-noida.yourapp.in` → slug `dps-noida`. The mobile app cannot set a
// subdomain, so it sends `X-Tenant-Slug` — the plan's documented fallback.
//
// The gateway does not trust either blindly: the subdomain must be under the
// configured TENANT_BASE_DOMAIN, and the forwarded hint header is normalized
// here. Nothing privileged rides on this header — credentials are verified
// against the routed tenant's own database — but forging it can only aim a
// login at a school the client already knew about.
// ──────────────────────────────────────────────

import type { RequestHandler } from 'express';

export const TENANT_SLUG_HEADER = 'x-tenant-slug';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Resolve the tenant slug for this request and set the downstream hint header.
 *
 * Priority: explicit `X-Tenant-Slug` (mobile) > subdomain of TENANT_BASE_DOMAIN.
 */
export function createTenantHintResolver(baseDomain?: string): RequestHandler {
  const domain = baseDomain?.toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');

  return (req, res, next) => {
    // Drop the client's copy first; we re-set it only when WE resolved it.
    // NOTE: delete the key — assigning `undefined` leaves the key present with
    // an undefined value, which http-proxy then forwards as
    // `x-tenant-slug: undefined` and Node rejects with
    // `Invalid value "undefined" for header "x-tenant-slug"`.
    delete req.headers[TENANT_SLUG_HEADER];

    // 1. Mobile fallback header. Validate the shape so a malformed value can
    //    never reach downstream resolution (or a log-injection).
    const explicit = req.header('x-tenant-slug');
    if (explicit && SLUG_RE.test(explicit.toLowerCase())) {
      req.headers[TENANT_SLUG_HEADER] = explicit.toLowerCase();
      res.setHeader('x-tenant-slug', explicit.toLowerCase());
      next();
      return;
    }

    // 2. Subdomain resolution against the configured apex domain.
    const host = (req.hostname || '').toLowerCase();
    if (domain && host.endsWith(`.${domain}`)) {
      const sub = host.slice(0, -1 * (domain.length + 1));
      // Only the first label is a tenant slug: `a.b.yourapp.in` is not a slug.
      if (sub && !sub.includes('.') && SLUG_RE.test(sub)) {
        req.headers[TENANT_SLUG_HEADER] = sub;
        res.setHeader('x-tenant-slug', sub);
      }
    }

    next();
  };
}
