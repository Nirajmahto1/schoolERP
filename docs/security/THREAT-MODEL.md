# STRIDE Threat Model (Phase 12.1 / Gate 12)

**System:** EduCore — multi-tenant school ERP. One Postgres cluster, one
database per school; a control plane holds the tenant registry and encrypted
connection refs. Public edge = api-gateway; 12 services private; clients are
the Next.js console and Flutter apps; processors: WhatsApp BSP, DLT SMS, SES,
FCM, Razorpay.

**Data classifications:** P1 = child identity + documents (Aadhaar-class,
photos), P2 = marks/fees/health flags, P3 = operational metadata.

**Assets ranked by harm:** 1) cross-tenant data — another school's students,
marks, fees, documents (existence of a leak is an existential sales event);
2) credential/integrity — forged assertions, session theft; 3) money — payment
capture/allocation and the ledger; 4) availability — the attendance morning
and result day; 5) logs/backups as secondary leakage surfaces.

| # | STRIDE | Threat scenario | Existing control | Residual risk / action |
|---|---|---|---|---|
| S1 | Spoofing | Forged `x-user-role: SUPER_ADMIN` headers at a reachable service port | `stripSpoofableHeaders` first middleware in every app factory + gateway strips before proxy; services verify RSA-signed assertions with per-service audience | Direct service ports must be network-private (compose internal network / SG rules). Ops control, in DEPLOYMENT.md |
| S2 | Spoofing | Stolen access token replayed | 15-min access TTL, refresh rotation with reuse-detection (identity-service), logout revokes via token store | Low. Enforce TLS-only cookies on web (done via SameSite+Secure in prod config) |
| S3 | Spoofing | Attacker mints an internal assertion | Private key only in gateway + explicit peer-callers; services hold public keys; audience pins service name | Key rotation runbook exists (RUNBOOKS#rotate-secrets). Rotate on schedule + on staff exit with repo access |
| S4 | Spoofing | Push/WS ticket theft (URL-borne ticket) | 60-s single-purpose tickets minted behind full auth; delivery-time tenant re-check | Accept (short window); never log full URLs on WS routes |
| T1 | Tampering | Mark/fee row edited in DB out-of-band | Append-only ledger for money (allocation rows immutable), marks entry writes audit rows with actor+timestamp | Money path verified in GATE 4 tests. Marks audit reviewed in Gate 3; add tamper-evident hash chain only if a school demands |
| T2 | Tampering | Webhook replay/injection (Razorpay, BSP) | HMAC over raw captured bytes; DB row is source of truth; reconcile job re-claims; idempotent claim race-safe | Proven by GATE 4 tests (duplicate webhook, dropped webhook) |
| T3 | Tampering | Path traversal on photo/document download | Server-generated filenames + strict regex allowlist before any path join | Tests cover fake-extension and traversal; keep regex when adding types |
| R1 | Repudiation | Staff denies mark change / cert issuance | AuditLog rows on marks, certificates, consent, erasure, attendance desk amendments; request-id in every log line | Retention: keep audit rows ≥ 7 years (school records norm); add to retention schedule |
| R2 | Repudiation | Parent denies consent | ConsentRecord stores capture method + evidence ref + timestamp; withdrawal also logged | Adequate for DPDP §6(1) proof-of-consent |
| I1 | Info disclosure | **Cross-tenant leak via IDOR** (`/students/:id`) | Every query scoped by assertion's tenant/branch; DB-per-tenant makes the boundary physical; isolation suite asserts 404/403 | Suite must reach 100% of endpoints (Gate 12 #2) — coverage manifest tracks it |
| I2 | Info disclosure | Cross-tenant leak via WebSocket/notification | Hub routes tenant-first, subscriber AND publisher tenant-checked, envelope carries tenant claim (GATE 6 leak test) | Keep the test in the PR-gate suite |
| I3 | Info disclosure | Document/photo over-fetch (staff reads student doc without role) | Photos/documents behind auth-gated routes; document access logged (DocumentAccessLog) | Verify staff-vs-parent role gates per route in isolation suite |
| I4 | Info disclosure | Verbose errors leak internals | problem+json envelope; 500s sanitised in production (`bootstrap.ts` finalize) | Keep `NODE_ENV=production` discipline in dist boots |
| I5 | Info disclosure | Log injection / secrets in logs | Structured JSON logs, no token/credential fields; gitleaks in CI | Add secret-pattern denylist to log reviewer checklist |
| I6 | Info disclosure | Backup exfiltration | Backups are files on disk + optional off-disk copy; verified restore drill | **Action:** encrypt backups at rest (age/BitLocker) — Phase 12 #5 follow-up before first paying tenant |
| D1 | DoS | Login brute force | ipAuthLimiter + per-account limiter (identity-service), 5/15min, skip-successful | Tuned; watch p99 during term start |
| D2 | DoS | Scraping via authenticated reads | identity-keyed read limiter (300/min default, env-tunable) | Adequate; alert on 429-rate spike |
| D3 | DoS | Oversized upload OOM | 5MB caps (photos/documents), 1–2MB JSON limits, Go streaming import for big files | Keep caps when adding upload types |
| D4 | DoS | Slowloris on gateway | `trust proxy` + upstream timeout (UPSTREAM_TIMEOUT_MS) | Add server.requestTimeout/headersTimeout in prod entrypoint — TODO before public TLS |
| E1 | Elevation | Role confusion (teacher → admin) | Roles come only from assertion claims minted post-auth; requireRole checks server-side per route | Isolation suite includes cross-role probes |
| E2 | Elevation | Compromised service pod mints assertions | Only gateway (+ declared peer callers) hold the private key; audience binding prevents cross-service replay | Keep private-key holding surface minimal when adding services |

**Top actions out of this model** (tracked in the security pack): backup
at-rest encryption, prod HTTP server timeouts, isolation-suite coverage to
100%, and the ops rule that service ports are never publicly reachable.
