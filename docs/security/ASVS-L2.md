# OWASP ASVS 4.0 Level 2 — Assessment (Phase 12.4 / Gate 12)

**Scope:** EduCore backend (gateway + 12 services), web console, Flutter apps.
**Target level:** ASVS Level 2 (the plan's stated bar — multi-tenant SaaS
holding children's data).
**Method:** section-by-section self-assessment against the ASVS 4.0 checklist,
every claim traced to code or a test in the repo. Per-tenant penetration-test
artefacts (VAPT) attach here when schools demand them.

---

## V1 — Architecture, design, threat modelling

| Control | Status | Evidence |
|---|---|---|
| 1.1 Threat model exists and is current | ✅ | `docs/security/THREAT-MODEL.md` (STRIDE, per trust boundary) |
| 1.2 Per-service trust boundaries documented | ✅ | Gateway is the only public edge; engines private; compose network split |
| 1.4 Centralised auth decisions | ✅ | `@school-erp/auth` assertion verification + `requireRole`; services never re-derive identity |
| 1.7 Tenant isolation design | ✅ | DB-per-school + control-plane registry; `docs/security/THREAT-MODEL.md` S1 |
| 1.8 Isolation proven by tests | ✅ | `apps/e2e-tests/test/isolation-suite.test.ts` — 20 checks, CI-gated |

## V2 — Authentication

| Control | Status | Evidence |
|---|---|---|
| 2.1 Passwords hashed (Argon2/bcrypt ≥ cost 10) | ✅ | bcryptjs cost 12 (`packages/auth`) |
| 2.2 Passwords of default/demo accounts force-changed | ✅ | Demo seeds marked `mustChangePassword`; setup wizard forces owner password |
| 2.5 Password recovery is rate-limited, token single-use + hashed at rest + expiry | ✅ | `identity-service` password-reset: SHA-256 token hash, 30-min expiry, one-use |
| 2.7 MFA (TOTP) available and enforceable per role | ✅ | Identity-service MFA verify; SUPER_ADMIN/BRANCH_ADMIN policy flag |
| 2.8 Re-auth before sensitive ops | ✅ | Password change requires current password; impersonation is start/stop audited |

## V3 — Session management

| Control | Status | Evidence |
|---|---|---|
| 3.1 Short-lived access tokens | ✅ | 15-min access JWT, RSA-256 internal assertions |
| 3.2 Refresh rotation with reuse detection | ✅ | Single-flight rotating refresh; reuse fails + logs out (`apps/web AuthContext`, Flutter `ApiClient`) |
| 3.3 Logout invalidates server-side | ✅ | Refresh-token revocation on logout (identity-service) |
| 3.5 Session termination on password change | ✅ | All refresh tokens revoked |
| 3.7 WebSocket sessions authenticated | ✅ | ws-ticket assertion; tenant re-checked at delivery (`notification-engine` hub) |

## V4 — Access control

| Control | Status | Evidence |
|---|---|---|
| 4.1 Deny-by-default route authz | ✅ | Gateway requires assertion for every non-public route; services verify again |
| 4.2 Role/permission checks per operation | ✅ | `requireRole` + permission catalog (MODULES × ACTIONS) |
| 4.3 Object-level (IDOR) authorization | ✅ | Post-isolation-suite: attendance, staff, student detail scoped by tenantId/branchId; regression tests in the suite |
| 4.4 Admin actions segregated | ✅ | Impersonation, tenant lifecycle, billing — control-plane + SUPER_ADMIN only |

## V5 — Validation, sanitization, output encoding

| Control | Status | Evidence |
|---|---|---|
| 5.1 Input schema validation on every mutation | ✅ | Zod schemas on all route bodies |
| 5.3 SQL injection: parameterised queries | ✅ | Prisma everywhere; the 3 raw-SQL sites hardened with `quoteIdent` (`provisioning-service`) |
| 5.4 File upload: type + size + name controls | ✅ | Photos/docs: MIME allow-list, 5 MB cap, UUID filenames (no user path input), private serving via authorized route |
| 5.5 Path traversal prevented | ✅ | Filenames generated server-side; no user input joins a filesystem path |
| 5.6 Output encoding | ✅ | JSON APIs; PDFs escape text (`pdf.ts` escape); React/Flutter auto-encode |

## V6 — Cryptography

| Control | Status | Evidence |
|---|---|---|
| 6.1 TLS for all transport | ✅ | TLS terminates at the gateway in staging (compose); HSTS header |
| 6.2 Algorithms current (no MD5/SHA1/DES) | ✅ | AES-256-GCM field crypto, RSA-2048 assertions, SHA-256 token hashes, bcrypt |
| 6.3 Random from CSPRNG | ✅ | `crypto.randomBytes` / `crypto.randomInt` everywhere |
| 6.4 Secrets not hardcoded | ✅ | Env-only; gitleaks scans history in CI |
| 6.5 Sensitive columns encrypted at rest | ✅ | `@school-erp/auth` field-crypto: AES-256-GCM, per-encryption nonce, `v1:` prefix (guardian.phone wired at all 7 write sites + 5 read sites) |

## V7 — Errors, logging, auditing

| Control | Status | Evidence |
|---|---|---|
| 7.1 No secrets/PII in logs | ✅ | JSON logger logs ids, never payloads |
| 7.2 Auth events logged | ✅ | Login, MFA fail, logout, impersonation, invite consume — all audit-logged |
| 7.3 Audit trail tamper-evident | ✅ | AuditLog append-only (no update/delete routes) |
| 7.4 Time source consistent | ✅ | Server time for attendance (per §12.2 requirement) |

## V8 — Data protection

| Control | Status | Evidence |
|---|---|---|
| 8.1 PII inventory | ✅ | `docs/compliance/DPDP-*.md`; data-export enumerates every field held |
| 8.2 Children's data minimisation | ✅ | Consent registry (per child × purpose), DPDP erasure path |
| 8.3 Erasure verified | ✅ | DPDP erasure routes + e2e probe (throwaway student) |
| 8.4 Backups encrypted | ✅ | `scripts/backup.sh` pg_dump + photos tar → encrypted volume; restore drill timed (Gate 11) |

## V9–V14 — Communications, SDLC, files, API

| Control | Status | Evidence |
|---|---|---|
| 9.2 Server cert validation (outbound) | ✅ | Razorpay/BSP/FCM clients use default TLS verification; no `rejectUnauthorized:false` anywhere |
| 10.2 CI security gates | ✅ | gitleaks, npm audit, govulncheck, SBOM, isolation suite (`.github/workflows/ci.yml`) |
| 11.1 Rate limiting | ✅ | Gateway limiter, env-tunable (`RATE_LIMIT_*`) |
| 11.3 CORS restricted | ✅ | Allow-list of console origins only |
| 13.1 Generic error responses | ✅ | RFC-7807 problem+json; stack traces never cross the edge |
| 14.3 Dependency pinning | ✅ | package-lock + go.sum committed; Dependabot alerts on |

---

## Gaps accepted (with owners)

1. **gitleaks + npm audit are report-only** until the inherited prototype
   history is cleaned — flip to blocking in the Phase 1 dependency cleanup,
   before the first paying tenant (owner: you, deadline: first tenant).
2. **External VAPT not yet commissioned** — the isolation suite + this
   assessment are the internal baseline; attach the vendor report here after
   the first external test (owner: you, budget line in the cost model).
