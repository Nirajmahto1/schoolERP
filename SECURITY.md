# Security Policy & Responsible Disclosure

## Supported deployments

Security fixes apply to the `master` branch. Schools run the managed
deployment — patches reach every tenant as part of the release train, and a
critical fix is an out-of-band release within 24 hours of triage.

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.**

- **Email:** security@educore.app (monitored; create the mailbox before launch)
- **PGP:** fingerprint published at `/.well-known/security.txt` once the key exists
- **Response clock:** acknowledgement within 48 hours; triage verdict within
  7 days; fix or mitigation plan within 30 days for confirmed issues.

Please include: affected endpoint(s) or app, reproduction steps, impact
assessment, and whether the issue is tenant-isolated. Good reports that we
confirm are acknowledged in the hall of fame below (opt-in).

## In-scope

- api-gateway and all 12 services (cross-tenant access, authz bypass, injection)
- notification-engine, timetable-engine, bulk-processor (Go engines)
- web console (`apps/web`), admin console, Flutter apps
- control-plane & provisioning (tenant isolation, lifecycle)
- Razorpay webhook / checkout verification, WhatsApp webhook verification

## Out of scope

- Volumetric DoS without a proof of resource exhaustion at realistic cost
- Self-XSS or social engineering of staff
- Reports from automated scanners without a working exploit path
- anything requiring a compromised device or MITM on the school's LAN

## Safe harbour

We will not pursue legal action against researchers who: use only
test/demo tenants or their own, avoid data exfiltration beyond a proof
(one record maximum), avoid service degradation, and report promptly.

## Disclosure timeline

1. Triage + severity (CVSS) within 7 days
2. Fix lands on master; critical fixes ship to all tenants ≤ 24h after triage
3. Public advisory in `docs/security/advisories/` ≥ 30 days after the fix is
   deployed to every tenant, with credit unless the reporter opts out.
