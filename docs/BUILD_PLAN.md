# School ERP — Build Plan to a Sellable Product

**Target:** Cloud SaaS, **one database per school**, polyglot microservices retained, **India** market, built **solo + AI** with no hard deadline.

**Written:** 2026-08-30

---

## How to read this document

Phases are **strictly ordered**. Each phase has a *Gate* — an objective condition that must be true before you start the next one. Do not skip gates. The whole point of ordering is that Phase 2 (schema redesign) must happen *before* any school has real data in it, and Phase 1 (tenant plumbing) must exist before Phase 3 builds twelve services on top of it.

Effort estimates assume **~25 focused hours/week, solo, with heavy AI assistance**. They are ranges, not promises.

| | |
|---|---|
| **Pilot-ready core** (Phases 0–5 + 8 partial + 10 partial) | ~5–7 months |
| **Sellable multi-branch product** (through Phase 13) | ~12–16 months |
| **What you have today** | ~12k lines, prototype, 0 tests, exploitable auth |

---

## Honest baseline: what exists today

| Area | State |
|---|---|
| `apps/web` | 30 dashboard pages, Next.js 14 + shadcn. Broadest asset you have. |
| `apps/student-service` | 1,229 lines — auth + students + parents. Most complete service. |
| `apps/staff-service` | 628 lines — staff, teacher, payroll, transport routes. |
| `apps/academic-service`, `fee-service`, `attendance-service`, `communication-service` | 74–328 lines each. Thin CRUD. |
| `apps/analytics-service`, `ai-service` (Python) | 277 / 84 lines. Stubs. |
| `apps/notification-engine`, `timetable-engine`, `go-service` (Go) | 195–428 lines. Stubs. |
| `apps/mobile` | Expo 54 / RN 0.81 / nativewind. 2,285 lines. Skeleton. |
| `packages/database` | 663-line Prisma schema, **no migrations directory**. |
| Tests | **None.** |
| CI/CD | **None.** |
| Git | **Not a repository.** |

### Blocking defects found in the current code

These are not style issues. Each one independently prevents selling.

1. **Forged-header privilege escalation.** `api-gateway/src/middleware/auth.ts:39-43` sets `x-user-id`, `x-user-role`, `x-branch-id`, `x-school-id` from the JWT, and every downstream service reads those headers as ground truth (`student.routes.ts`, `staff-service/index.ts`, `fee-service/index.ts`, `academic-service/index.ts` — 40+ call sites). No service verifies a token. Anyone who can reach port 4001–4006 directly sends `x-user-role: SUPER_ADMIN` with any `x-school-id` and owns every school. In Docker/K8s those ports are reachable from any sibling container.
2. **Public super-admin registration.** `POST /api/v1/auth/register` is mounted with *no* auth middleware (`api-gateway/src/index.ts:46-50`) and `registerSchema` accepts `role: 'SUPER_ADMIN'` plus attacker-chosen `branchId`/`schoolId` (`auth.routes.ts:19-28`).
3. **Hardcoded fallback secrets.** `process.env.JWT_SECRET || 'fallback-secret'` / `|| 'secret'` / `|| 'refresh-secret'` in the gateway and auth routes. A missing env var silently downgrades to a secret published in your source.
4. **No token revocation.** 7-day access tokens, 30-day refresh, no `jti`, no denylist. Logout is cosmetic. `/auth/refresh` re-signs claims from the old token, so a fired teacher or demoted admin keeps their privileges for 30 days and a deactivated user still gets fresh access tokens.
5. **`cors({ origin: true, credentials: true })`** reflects any origin with credentials.
6. **Rate limit is 1000 req / 15 min globally** — no per-IP login throttle, no lockout. Brute-forcing a parent password is trivial.
7. **No migrations.** You cannot upgrade a paying school's database without risking data loss.
8. **Multi-tenant schema landmines.** Globally unique `Student.admissionNo`, `Staff.employeeId`, `Book.isbn`, `Vehicle.vehicleNo`, `Payment.receiptNo`, `User.email`. Two branches cannot both stock ISBN 9780143331773; a teacher cannot work at two branches; a parent cannot have children at two branches.
9. **No enrollment history.** `Student.classId` is a live pointer. The moment you promote a student, last year's report card, TC, and attendance percentage become unreproducible. This is the single most expensive mistake to fix later.
10. **`RolePermission` maps `userId → permissionId`** — it is per-*user* permissions with a role-shaped name. There is no `Role` table.
11. **README claims modules that do not exist**: hostel, inventory, online classes, admission portal, document management, PWA, compliance.

---

## Architecture decision record

### ADR-1: Database-per-tenant, single Postgres cluster

You chose DB-per-school. Implement it as **one Postgres cluster containing N school databases**, plus **one separate control-plane database**. Not one cluster per school — that is 40× the cost with no added isolation for your threat model.

```
┌─────────────────────────────────────────────────────┐
│  CONTROL PLANE DB  (platform-owned, 1 total)        │
│  tenants · plans · subscriptions · saas_invoices    │
│  tenant_datastores (encrypted conn strings)         │
│  user_directory (email_hash → tenant_id)            │
│  platform_admins · migration_runs · provision_audit │
└─────────────────────────────────────────────────────┘
             │ resolves tenant → connection
             ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ tenant_dps   │ │ tenant_ryan  │ │ tenant_...   │
│ branches     │ │ branches     │ │              │
│ users        │ │ users        │ │   (N school  │
│ students     │ │ students     │ │    DBs, one  │
│ fees ...     │ │ fees ...     │ │    cluster)  │
└──────────────┘ └──────────────┘ └──────────────┘
```

**Consequence:** the `School` model moves *out* of the tenant schema into the control plane. `Branch` stays. Every global-unique constraint in the tenant schema becomes scoped to `(branchId, …)`. This is why Phase 2 fixes the schema *after* Phase 1 establishes tenancy — the tenancy model determines the constraints.

### ADR-2: Connection-pool budget (this will bite you if ignored)

Naive math with your architecture:

```
12 services × 50 tenants × Prisma default pool (2×CPU+1 ≈ 9)
  = 5,400 Postgres connections
Postgres realistically handles ~200–500.
```

**Mandatory mitigations, all three:**

1. **PgBouncer in transaction mode** in front of the cluster. Prisma connection strings get `?pgbouncer=true&connection_limit=1`. (Prisma disables prepared-statement caching when it sees `pgbouncer=true`; without it you get `prepared statement "s0" already exists` errors under load.)
2. **LRU `PrismaClient` cache per service process** — cap at ~20 live tenant clients, evict on 10-min idle with explicit `$disconnect()`. Lives in `@school-erp/tenant`.
3. **Only services that need a tenant connect to it.** The notification and timetable engines should read via API or a queue, not open their own tenant pools.

Escape hatch: if connection pressure still bites past ~150 schools, switch to **schema-per-tenant in a shared database** (`SET search_path`). It preserves per-school export/isolation while letting one physical connection serve many tenants. Design the `@school-erp/tenant` interface so this swap is a one-file change.

### ADR-3: Service-to-service authentication

Replace trusted headers with cryptography.

- Gateway validates the *user's* token, then **mints a short-lived internal assertion**: EdDSA/RS256-signed JWT, 60-second TTL, claims `{ sub, tenantId, branchId, roles[], jti, aud: "<service>" }`.
- Every service verifies that assertion against a JWKS endpoint. A request without a valid assertion is rejected — **no header fallback, ever**.
- The gateway **strips all inbound `x-user-*`, `x-branch-*`, `x-school-*`, `x-tenant-*` headers** before setting its own, on *every* route including unauthenticated ones.
- Services bind to a private network only; add a network policy so nothing but the gateway can reach them.
- Ship this as `@school-erp/auth` so all 12 services get it from one place. This is the concrete answer to defect #1.

### ADR-4: Shared packages are not optional

With 12 services, a fix applied 12 times is a fix applied 8 times. Build these first (Phase 1.6):

| Package | Responsibility |
|---|---|
| `@school-erp/config` | Zod-validated env at boot. **Missing var = crash**, no fallbacks. |
| `@school-erp/auth` | Internal assertion mint/verify, RBAC guard, JWKS client. |
| `@school-erp/tenant` | Tenant resolution, connection routing, LRU client cache. |
| `@school-erp/http` | Error envelope (keep your RFC-7807 style), request ID, logging, OTel tracing, health/readiness. |
| `@school-erp/database` | Prisma schema, migrations, generated client. |
| `@school-erp/shared-types` | Shared DTOs — exists, needs to become the contract source. |
| `@school-erp/testing` | Testcontainers Postgres, tenant fixture factory, auth token helpers. |

---

# PHASE 0 — Make the repo safe to build on

**Goal:** stop the bleeding. No new features. ~2–3 weeks.

**Why it's first:** every hour spent building features on top of forged-header auth is an hour you will spend again.

### 0.1 Version control
1. `git init`, verify `.gitignore` covers `.env`, `node_modules`, `.next`, `dist`, `.venv`, `*.exe`, `.turbo`, `.codex-logs`.
2. First commit as `baseline: prototype as inherited`.
3. Branch protection on `main` once you have CI (0.8).

### 0.2 Repo hygiene
1. Delete `blackjack/` (unrelated card game at repo root).
2. Move `verify_staff.ts`, `packages/database/test.ts`, `packages/database/insert_admin_staff.ts` into `scripts/dev/` or delete.
3. Remove committed binaries: `apps/go-service/go-service.exe`, `apps/go-service/bin/`, `__pycache__`.
4. Reconcile the Postgres port: `docker-compose.yml` publishes `5433:5432` but `.env.example` says `5432`. Fix the example.
5. Rewrite `README.md` to describe **what exists**, and move aspirational modules into this plan. A README that overstates is a README you can't trust during a demo.

### 0.3 Close the auth holes
1. **Delete `POST /auth/register`.** Replace with invite-only provisioning: platform admin creates the school + first admin (Phase 1.2); school admins invite users via signed, single-use, expiring invite tokens.
2. **Remove every `|| 'secret'` fallback.** Introduce `@school-erp/config` (0.6) and fail fast at boot.
3. Access token → **15 minutes**. Refresh token → 30 days, **rotating, with reuse detection**, stored hashed in Redis with `jti`. Reuse of a rotated refresh token revokes the whole family.
4. `/auth/refresh` must **re-read the user from the DB** — verify `isActive`, re-fetch current roles. Never re-sign old claims.
5. Real logout: revoke the refresh family, add access `jti` to a Redis denylist until natural expiry.
6. Password rules: bcrypt cost 12 (already correct), min length 10, breach-list check (`k-anonymity` range API against HIBP), forced change on first login for provisioned accounts.
7. Login throttling: 5 attempts / 15 min / IP **and** per account; exponential backoff; lock at 10 with admin unlock. Never leak whether an email exists.

### 0.4 Gateway hardening
1. Strip inbound `x-*` identity headers on **all** routes.
2. CORS: explicit allowlist from config (your app domains + tenant subdomains), not `origin: true`.
3. Per-route rate limits: auth 5/min, writes 60/min, reads 300/min, keyed on tenant + user, backed by Redis (`rate-limit-redis`) so limits survive restarts and multiple instances.
4. Request size caps, timeouts on every proxy target, circuit breaker so one dead service doesn't hang the gateway.
5. `helmet` is present — add HSTS, CSP for the web app, and disable `x-powered-by`.

### 0.5 Service-to-service auth (ADR-3)
1. Generate an EdDSA keypair; gateway signs, services verify; publish JWKS at `/.well-known/jwks.json`.
2. Implement `mintAssertion()` / `requireAssertion()` in `@school-erp/auth`.
3. **Mechanically replace all 40+ `req.headers['x-user-id']` reads** with `req.ctx.userId` from the verified assertion. Grep for `x-user-id|x-branch-id|x-school-id|x-user-role` and drive it to zero.
4. Add a test that hits a service directly with forged headers and asserts **401**.

### 0.6 Config discipline
1. `@school-erp/config` — one Zod schema per service, parsed at boot, process exits on failure.
2. Secrets from environment only; document that production uses AWS Secrets Manager / Doppler / sops, never `.env`.
3. Add a `pnpm run doctor` script that checks Docker services, DB reachability, and env completeness.

### 0.7 Test harness
1. **Vitest** + **supertest** for Node services; **testcontainers** for a real ephemeral Postgres per suite.
2. `@school-erp/testing`: spin up tenant DB, run migrations, seed, mint tokens for each role.
3. Write the first 20 tests against `student-service` auth and student CRUD. Target: every route you touch from here on ships with tests.
4. **Cross-tenant isolation suite** — the most commercially important tests you will ever write. For every endpoint: authenticate as tenant A, request tenant B's resource ID, assert 404 (not 403 — don't confirm existence). Automate so it runs on every PR.
5. `pytest` for Python services, `go test` for Go services.

### 0.8 CI/CD
1. GitHub Actions: lint → typecheck → unit → integration → build all 14 apps → Docker image build.
2. Turborepo remote cache so CI doesn't rebuild everything.
3. Dependabot / Renovate + `npm audit` + `gitleaks` secret scanning + CodeQL.
4. Fail the build on new `any`, on skipped tests, and on coverage regression.

### 0.9 Migration baseline
1. `prisma migrate diff` from empty → current schema to produce `0000_baseline`.
2. Commit `packages/database/prisma/migrations/`. **Never use `db push` again.**
3. Document the rule: schema changes are additive-then-backfill-then-remove, so migrations are always reversible against a live school.

> ### GATE 0
> - `git log` exists; CI green on `main`.
> - Forged-header test returns 401 on every service.
> - `grep -rn "x-user-id\|x-branch-id\|x-school-id" apps/*/src` returns **nothing**.
> - `grep -rn "|| 'secret'\|fallback-secret"` returns **nothing**.
> - `/auth/register` is gone.
> - Baseline migration committed; `prisma migrate deploy` works on a fresh DB.
> - ≥30 tests passing, including the cross-tenant isolation suite.

---

# PHASE 1 — Multi-tenant control plane

**Goal:** the machinery that lets you onboard school #2 without touching code. ~4–6 weeks.

**Why here:** this is your product's spine and it dictates Phase 2's schema. It is also the thing no ERP prototype ever has, and the reason most never become a business.

### 1.1 Control-plane schema (new `packages/control-plane`)

```
tenant            id, slug (subdomain), legal_name, status
                  (TRIAL|ACTIVE|SUSPENDED|CHURNED|DELETING),
                  plan_id, region, created_at, trial_ends_at
tenant_datastore  tenant_id, kind (POSTGRES|S3_PREFIX),
                  conn_ref (KMS-encrypted), schema_version, last_migrated_at
plan              code, name, price_per_student_year, max_branches,
                  max_students, feature_flags jsonb
subscription      tenant_id, plan_id, period_start/end, seats,
                  status, billing_anchor
saas_invoice      tenant_id, amount, gst_amount, status, razorpay_order_id
user_directory    email_hash, tenant_id, user_id   ← login routing only
platform_admin    email, password_hash, totp_secret, role
migration_run     tenant_id, from_version, to_version, status,
                  started_at, finished_at, error
provision_audit   actor, action, tenant_id, payload, at
support_grant     tenant_id, platform_admin_id, reason, expires_at
```

Notes:
- `user_directory` stores a **hash** of the email, never the address — it's a cross-tenant index and must not become a customer list leak.
- `support_grant` is how *you* access a school's data for support: time-boxed, reasoned, audited, and surfaced to the school. Schools will ask "can your staff see our data?" Have a real answer.

### 1.2 Provisioning service (new `apps/provisioning-service`)

Idempotent, resumable pipeline:
1. Validate slug availability (reserve `www`, `api`, `admin`, `app`, `status`…).
2. `CREATE DATABASE tenant_<slug>` + a least-privilege role per tenant (no superuser, no cross-DB read).
3. `prisma migrate deploy` against the new DB.
4. Seed India defaults: academic year, class structure (Nursery→XII), CBSE grading scheme, fee heads, holiday calendar, role definitions.
5. Create MinIO/S3 bucket prefix + scoped credentials.
6. Create the school's first `BRANCH_ADMIN` with a one-time setup link.
7. Write `tenant_datastore`, flip status to `TRIAL`.
8. **Rollback path** for every step; a half-provisioned tenant must be cleanable by one command.

Deliver a CLI too: `pnpm tenant:create --slug dps-noida --branches 3`. You'll use it for every demo.

### 1.3 Tenant resolution + connection routing (`@school-erp/tenant`)
1. Resolve tenant from **subdomain** (`dps-noida.yourapp.in`) — cleanest, because you know the tenant *before* login. Fallback header `X-Tenant-Slug` for the mobile app.
2. Cache `slug → { tenantId, connRef, status }` in Redis, 60s TTL, with explicit invalidation on tenant update.
3. `getTenantClient(tenantId)`: LRU cache (max 20, 10-min idle eviction, `$disconnect` on evict) per ADR-2.
4. Reject requests to `SUSPENDED`/`DELETING` tenants with a clear 402/423.
5. **`AsyncLocalStorage` request context** so no function signature needs threading — and so you can assert in tests that no query runs without a tenant bound.
6. A lint rule or runtime guard: **any Prisma call outside a tenant context throws.** This is your defence against the class of bug that leaks School A's marks to School B.

### 1.4 Migration orchestrator (`apps/provisioning-service`, or a CLI)

Non-negotiable with DB-per-tenant.
1. `tenant:migrate --all` — fan out with bounded concurrency (5–10), record every attempt in `migration_run`.
2. `--dry-run` producing the SQL diff per tenant.
3. Stop-on-first-failure with a resume-from-failure mode; never leave the fleet at mixed versions silently.
4. `tenant:status` — a table of tenant → schema version → drift, so you can see the fleet at a glance.
5. Canary ordering: internal demo tenant → your own test school → pilot schools → everyone.
6. Alert loudly when any tenant drifts from the target version.

### 1.5 Tenant lifecycle
1. Suspend (non-payment) — read-only mode, banner, no data deletion.
2. Resume, plan change, seat recount.
3. Delete with **retention window** (30/60/90 days per contract), then hard delete + certificate of deletion. DPDP makes this a legal obligation, not a nice-to-have.
4. **Per-tenant export**: full data dump as SQL + CSV bundle + files. Sell this as "your data is yours" — it wins deals and satisfies DPDP data-portability.
5. **Per-tenant backup + point-in-time restore, and a rehearsed single-tenant restore.** Restoring one school without touching the other 99 is the drill that matters; run it quarterly and record the time.

### 1.6 Shared packages
Build all seven from ADR-4. Then **migrate the existing 7 Node services onto them** — this is mostly deletion, and it's where the 12-service tax starts paying down.

### 1.7 Platform admin console (`apps/admin-console`, Next.js)
Tenants list + health, provisioning wizard, migration fleet view, subscription/billing state, feature flags, support-grant request flow, per-tenant usage (students, storage, SMS credits). You need this before school #3, not after.

> ### GATE 1
> - `pnpm tenant:create` provisions a working school end-to-end in under 2 minutes.
> - Three tenants live locally; the isolation suite passes against all three.
> - `tenant:migrate --all` upgrades all three and reports per-tenant status.
> - A Prisma call with no tenant context **throws**.
> - Single-tenant restore-from-backup rehearsed and timed.
> - All 7 Node services consume the shared packages.

---

# PHASE 2 — Domain model redesign

**Goal:** get the schema right while the cost of changing it is still zero. ~5–7 weeks.

**Why here:** after this phase, every change costs a migration across N live school databases. Do it now.

### 2.1 Identity, roles, and multi-branch people
1. Delete `RolePermission(userId, permissionId)`. Introduce:
   - `Role` (system + custom per tenant), `Permission` (`module.action`), `RolePermission(roleId, permissionId)`.
   - `UserRoleAssignment(userId, roleId, branchId?)` — **branch-scoped**, so one person can be Teacher at Branch A and Coordinator at Branch B.
2. `User.email` unique **per tenant** (it already is, since the DB is the tenant) — but drop the assumption of one user per branch. Delete `User.schoolId` (implied by the database) and `User.branchId` (superseded by role assignments); keep a `defaultBranchId` for UX.
3. **Guardian model rewrite.** Replace the father/mother/guardian column block on `Parent` with:
   - `Guardian` (one row per real person, own login),
   - `StudentGuardian(studentId, guardianId, relation, isPrimary, canPickup, receivesComms, hasPortalAccess)`.
   Reasons this matters commercially: divorced/separated parents, single guardians, grandparents, siblings sharing guardians, and "who is legally allowed to collect this child" — schools ask about that one directly.
4. Staff: `employeeId` unique per branch; `StaffBranchAssignment` for shared teachers.
5. Add `mfa_secret` for admin/finance roles.

### 2.2 Academic structure and history — the critical fix
1. **`StudentEnrollment`**: `(studentId, academicYearId, branchId, classId, sectionId, rollNo, status[ENROLLED|PROMOTED|DETAINED|TC_ISSUED|LEFT], fromDate, toDate)`.
   Remove `classId`/`sectionId`/`rollNo` from `Student`. Everything — attendance, report cards, fees, TCs — hangs off the enrollment, not the student.
2. **Promotion engine**: bulk promote a section, mark detained, carry forward balances, roll over next year's classes. Preview → confirm → reversible batch. Every Indian school does this every March; if it's manual you will lose the account.
3. `AcademicYear` with a single-`isCurrent` guarantee (partial unique index), plus term/semester subdivisions.
4. Subject model: per-class subject offering, electives, groups/streams (Science/Commerce/Humanities for XI–XII), optional-subject selection per student.
5. `AcademicCalendar` — working days, holidays, events, exam windows, per branch. Attendance percentage is meaningless without it.

### 2.3 Number sequences and scoped uniqueness
1. A `Sequence` table + `nextval` helper, transactional and gap-tolerant, for: admission no, receipt no, invoice no, TC no, employee ID.
2. Configurable format per branch: `DPS/2026-27/00042`. Schools care about this; hardcoding it causes rework.
3. Rescope every global unique: `@@unique([branchId, admissionNo])`, `@@unique([branchId, employeeId])`, `@@unique([branchId, isbn])`, `@@unique([branchId, vehicleNo])`, `@@unique([branchId, receiptNo])`.

### 2.4 Attendance, properly
1. Support **daily** *and* **period-wise** (secondary schools mark per subject; primary marks once).
2. `AttendanceSession(branchId, date, classId, sectionId, period?, subjectId?, markedBy, lockedAt)` + `AttendanceRecord(sessionId, studentId, status, reason)`.
3. Statuses: present, absent, late, half-day, on-approved-leave, medical, excused. Keep `ON_LEAVE` linked to a leave record.
4. **Immutability + audit**: after a lock window (e.g. 48h), only a principal can amend, and every amendment is logged with before/after. Attendance disputes are real and you need the trail.
5. Staff attendance separately, with biometric-device import as a later adapter.
6. Denormalised monthly summary table, rebuilt by a job — never compute a term's percentage by scanning raw rows at request time.

### 2.5 Fees — the module that decides whether you get paid
The current 5-model design cannot represent a real Indian fee book. Rebuild:
1. `FeeHead` (Tuition, Transport, Admission, Exam, Lab, Annual, Late Fee) with `isRecurring`, `isRefundable`, GST applicability.
2. `FeeStructure` versioned per academic year + class + optional student category; `FeeStructureLine(feeHeadId, amount, frequency, dueDay)`. Drop the unnormalised `classIds String[]` — make it a join table so you can actually query it.
3. **`Concession`** — scholarship, sibling discount, staff ward, RTE quota (25% under the RTE Act is a real, reportable category), merit. Percentage or flat, per head or total, with approval workflow and validity.
4. **`FeeLedger`** — append-only entries (`DEMAND`, `PAYMENT`, `CONCESSION`, `LATE_FEE`, `ADJUSTMENT`, `REFUND`, `WRITE_OFF`) per student. Balance is a derived sum, never a mutable column. This is the difference between an accountant trusting you and not.
5. `Invoice` + `InvoiceLine` generated from structure × enrollment × concessions, by a scheduled job, idempotent per (student, period).
6. **Payment allocation rules** — oldest-dues-first vs head-priority, configurable; partial payments must allocate deterministically.
7. **Late fee engine** — grace days, flat/per-day/percentage, caps, holiday-aware, waiver with reason + approver.
8. Refunds and cancellations with reversal entries (never delete a payment row).
9. `Payment` state machine: `INITIATED → PENDING → SUCCESS | FAILED | REFUNDED | DISPUTED`, with `idempotencyKey`, `gatewayOrderId`, `gatewayPaymentId`, raw webhook payload retained.
10. Reports accountants demand on day one: daily collection, head-wise collection, defaulters by class, concession register, projected vs collected, cheque bounce register, cash-vs-online reconciliation.

### 2.6 Examinations and report cards
1. `AssessmentType` — periodic test, half-yearly, annual, practical, project, internal assessment.
2. `GradingScheme` + `GradeBand` (CBSE A1–E, percentage, CGPA, and descriptive for primary). Versioned per year.
3. `CoScholasticArea` + descriptive grades (work education, art, health — required on CBSE report cards).
4. `ExamResult` gains: `isAbsent`, `isExempt`, `attemptNo`, `enteredBy`, `verifiedBy`, `moderatedMarks`, `remarks`.
5. **Result publication workflow**: entry → subject-teacher submit → coordinator verify → principal publish. Nothing is parent-visible until published. Marks leaking early is a scandal at a school.
6. `ReportCardTemplate` — per board/class, with weightage rules, best-of-N, term aggregation, rank/percentile (rank optional; some boards forbid it).
7. PDF generation with the school's letterhead, signatures, watermark; batch-generate a whole section.
8. Mark-entry audit: who changed a mark, from what, when, why.

### 2.7 Cross-cutting concerns
1. **`AuditLog`** — actor, tenant, branch, entity, action, before/after diff, IP, user agent, at. Cover every write to marks, fees, attendance, users, and permissions. Non-negotiable for compliance and for the "your software changed my child's marks" conversation.
2. **Soft delete** (`deletedAt`, `deletedBy`) with a Prisma extension that filters by default. Schools delete things by accident constantly.
3. `Document` — typed file records (birth certificate, Aadhaar, TC from previous school, caste certificate, photos, medical) with S3 key, checksum, virus-scan status, retention policy, and **access log** (child data — who viewed it matters).
4. `Setting` — per tenant and per branch, typed, with defaults, so schools self-serve configuration instead of emailing you.
5. `NotificationLog` — channel, template, recipient, status, provider message ID, cost. Needed for delivery disputes *and* for billing SMS credits.
6. `Holiday`, `Timetable` with teacher-clash constraints, substitution log.

### 2.8 Migration path
Write a one-way transformer from the current schema to the new one (`Parent` → `Guardian`+`StudentGuardian`, `Student.classId` → `StudentEnrollment`, `RolePermission` → roles). Test on seeded data. If any real data already exists anywhere, this is the only safe route.

> ### GATE 2
> - New schema migrated; seed produces a realistic 3-branch, 1,200-student, 2-academic-year school.
> - Reproduce a **previous year's** report card and attendance percentage from history. (This is the test that proves 2.2 worked.)
> - Fee ledger balances tie out against invoices and payments for every seeded student.
> - Promotion engine promotes a section and is reversible.
> - No global unique constraints remain in the tenant schema.

---

# PHASE 3 — Core services buildout

**Goal:** turn thin CRUD into real modules. ~10–14 weeks. Build in dependency order; each service is *finished* before the next starts.

For **every** service, "done" means: Zod-validated input · RBAC on every route · tenant-scoped queries · pagination/filter/sort · consistent error envelope · OpenAPI spec · unit + integration tests · isolation tests · seed data · structured logs + traces · README.

**Order and scope:**

1. **identity-service** (extract auth out of `student-service` — auth living inside students is why that file is 1,229 lines). Login, MFA for admin/finance, refresh rotation, invites, password reset, sessions/device list, permission resolution, impersonation-with-audit for support.
2. **student-service** — admissions enquiry → application → admission, profile + documents, enrollment, promotion, transfers between branches, TC/bonafide generation, siblings, alumni. Bulk Excel import with per-row validation and a downloadable error report. **This import tool is your #1 sales unblocker** — every school hands you a messy spreadsheet.
3. **academic-service** — classes, sections, subjects, electives/streams, teacher allocation, syllabus/lesson plans, homework/assignments, academic calendar.
4. **attendance-service** — daily + period-wise marking, bulk mark, corrections with audit, leave workflow, absentee auto-notification to guardians, monthly summaries, defaulter (<75%) reports.
5. **fee-service** — everything in 2.5. Biggest module; budget 3–4 weeks alone.
6. **exam-service** (new; currently buried in `academic-service`) — everything in 2.6.
7. **staff-service** — staff records, contracts, leave with balances/accrual, payroll (basic + allowances + deductions, PF/ESI/TDS fields, payslip PDF), appraisals, substitution management.
8. **communication-service** — announcements with role/class/section targeting, templates, scheduling, multi-channel dispatch, read receipts, PTM scheduling, complaint/query desk.

Then, only if a customer actually asks: library, transport (with route/stop/GPS-ready model), hostel, inventory.

> ### GATE 3
> - A full academic year can be run end-to-end on seeded data: admit → enroll → timetable → attendance → exams → report card → fee cycle → promote.
> - Every route has RBAC and an isolation test.
> - OpenAPI spec published for all services.
> - ≥60% coverage on fee and exam logic (the two places bugs cost you a customer).

---

# PHASE 4 — Payments and your own billing

~3–4 weeks.

### 4.1 School fee collection (Razorpay primary, PayU as fallback)
1. Order creation, checkout, **webhook signature verification**, idempotent handling, retries with exponential backoff.
2. **Reconciliation job** — never trust the client callback. Poll gateway settlements, match against `Payment`, flag mismatches for a human. Money bugs destroy trust permanently.
3. Payment methods Indian parents actually use: UPI (incl. intent/QR), cards, netbanking, wallets, **NEFT with virtual account per student** (large schools want this), cash/cheque entry with bank-deposit tracking.
4. Receipt PDF, numbered from the `Sequence` table, emailed + WhatsApp, downloadable from the parent portal.
5. Partial payments, advance payments, dues carry-forward across years.
6. Settlement report for the accountant: gateway charges, net credited, date-wise.
7. Optional: **Razorpay Route / split settlement** so fees land in the school's account directly rather than yours — this removes you from the money-custody path and is *much* easier to sell and to stay compliant with. Strongly consider it.
8. Cheque bounce handling with penalty entry.

### 4.2 Your SaaS billing
1. Plan definitions (per-student/year is the norm in India), branch and student caps, feature flags.
2. Trial → paid conversion, invoice generation with **18% GST**, HSN/SAC code, your GSTIN, and the school's GSTIN for input credit. Schools will ask for a proper tax invoice.
3. Dunning: reminders → grace → read-only suspension → churn. Automated, with human override.
4. Usage metering: students, storage, SMS/WhatsApp credits.
5. Consult a CA on whether you're supplying to registered entities, TDS applicability, and e-invoicing thresholds. Get this right before your first invoice, not after twelve.

> ### GATE 4
> - End-to-end paid fee in Razorpay **test** mode, reconciled, receipt generated.
> - Deliberately dropped webhook is recovered by the reconciliation job.
> - Duplicate webhook does not double-credit (idempotency proven by test).
> - Refund produces correct reversal ledger entries.

---

# PHASE 5 — Communication (India-specific)

~3–4 weeks. This is the feature parents *notice*, so it drives renewals.

1. **WhatsApp Business Platform** via a BSP (Gupshup / Interakt / AiSensy / Meta Cloud API direct). Pre-approved message templates, opt-in handling, delivery receipts, per-message cost tracking. In India, WhatsApp beats SMS and email combined for parent reach.
2. **SMS with DLT compliance** — TRAI requires registered sender ID (header) and pre-registered content templates on the DLT portal. Unregistered traffic is blocked. Budget real calendar time for the registration itself; it is bureaucratic, not technical.
3. Email via SES/Postmark with SPF/DKIM/DMARC on the school's domain if they want it.
4. Push notifications for the mobile app (FCM + APNs).
5. **Unified dispatcher**: choose channel by preference + template + fallback chain, queue with retries, dead-letter, and log every attempt to `NotificationLog`.
6. Automated triggers: absence alert (same morning), fee due/overdue, exam schedule, result published, PTM invite, holiday notice, emergency broadcast.
7. Credit metering + top-up so messaging costs pass through to the school rather than eating your margin.
8. Quiet hours, throttling, and an unsubscribe path for non-transactional messages.

> ### GATE 5
> - Absence alert reaches a real phone via WhatsApp within 2 minutes of marking.
> - Delivery status and per-message cost recorded.
> - DLT registration submitted (or the BSP's headers in use).

---

# PHASE 6 — Make the Go services real

~4–5 weeks. Currently 195–428 line stubs. These are the three jobs where Go genuinely earns its place.

1. **notification-engine** — WebSocket fan-out for live dashboards and in-app notifications; Redis pub/sub; per-tenant channel isolation (a bug here cross-posts School A's announcement to School B); presence; reconnect with backpressure. Authenticate the socket with the same internal assertion, and re-authorise on every subscribe.
2. **timetable-engine** — the strongest Go case in the whole system. Constraint solver: teacher availability, subject periods/week, room capacity, lab blocks, teacher max-periods/day, no back-to-back clashes, games/library slots. Implement CP/simulated annealing with a hard-constraint checker; support locked slots and partial regeneration; produce substitution suggestions when a teacher is absent. Schools currently do this on paper over a week — automating it is a genuinely compelling demo.
3. **bulk-processor** — Excel/CSV import at scale (students, marks, fees), streaming parse, per-row validation, partial commit with error report, progress via WebSocket. Also batch PDF generation (500 report cards, 1,200 receipts).
4. Retire `apps/go-service` (the generic one) or fold it into `bulk-processor` — three Go services with overlapping identities is exactly the tax ADR-4 warns about.

> ### GATE 6
> - Timetable generated for a 3-branch school with zero hard-constraint violations, and a clash-injection test proves the checker works.
> - 5,000-row student import completes with a per-row error report.
> - WebSocket cross-tenant leak test passes.

---

# PHASE 7 — Analytics and AI (last, deliberately)

~4–6 weeks. Currently 84–277 line stubs. Do this **after** you have real data, because AI on invented data is a demo that dies in the first pilot.

1. **analytics-service** (FastAPI):
   - Read from a **replica**, never the primary.
   - Materialised views / summary tables per tenant, refreshed on a schedule.
   - Dashboards: enrollment trends, attendance heatmaps, fee collection funnel, class/subject performance distribution, teacher workload, branch comparison (the thing a chain's management office actually buys).
   - A report builder with saved reports and scheduled email/WhatsApp delivery.
   - Export to Excel/PDF. Schools live in Excel; fight it and you lose.
2. **ai-service** (FastAPI) — only ship what you can defend:
   - **At-risk student detection** (attendance + marks + fee-default trend). Ship it as a *ranked list with reasons*, never a black-box score. Validate against a year of history before you show it to a principal.
   - **OCR** for admission documents and cheque/receipt data entry.
   - **Timetable suggestions** feeding the Go engine.
   - Optional: fee-default prediction, admission-enquiry lead scoring, natural-language query over reports.
   - Be explicit in your marketing about what is statistics and what is ML. Overclaiming AI to a school principal is a short-term win and a long-term refund.
3. **MongoDB decision point.** It's in `docker-compose` and `.env` for "logs" but nothing uses it. Either give it a real job (audit/event stream, notification logs) or delete it. An unused datastore is a security surface, a backup obligation, and a line item.

> ### GATE 7
> - Branch-comparison dashboard renders for a 3-branch tenant in under 2s.
> - At-risk model validated against held-out historical data with reported precision/recall.

---

# PHASE 8 — Frontend maturity

~8–10 weeks, run partly in parallel with Phase 3 (build each screen as its API lands).

1. **Design system** on shadcn/ui: tokens, dark mode, dense data-table variant, empty/loading/error states, toasts, confirm dialogs. One pass now saves 30 inconsistent screens later.
2. **Role-based navigation** — the current `Sidebar`/`RoleGuard` needs to become permission-driven, not role-string-driven, so custom roles work.
3. **Data tables**: server-side pagination, sort, filter, column visibility, saved views, bulk actions, CSV export. Schools have 3,000 students; client-side filtering dies.
4. **Forms**: react-hook-form + Zod sharing schemas with the backend via `shared-types`, autosave on long forms, unsaved-change guards.
5. **Bulk import UX** — upload → column mapping → dry-run preview → validation errors inline → commit. Treat this as a flagship feature, not a utility.
6. **Branch switcher** for multi-branch users, plus an **all-branches consolidated view** for management. This is the multi-branch selling point; make it visibly good.
7. **PWA + offline attendance** — teachers mark attendance on phones in corridors with bad wifi. Service worker, IndexedDB queue, conflict resolution on sync. This wins demos.
8. **Accessibility** (WCAG 2.1 AA): keyboard nav, focus management, ARIA on tables/dialogs, contrast. Also required by some tenders.
9. **i18n**: English + Hindi first, then Marathi/Tamil/Telugu/Gujarati/Bengali as markets demand. Externalise strings from day one — retrofitting is miserable.
10. **Performance**: route-level code splitting, RSC where it helps, `<300ms` p75 interaction, skeleton states, image optimisation for photos.
11. **Print layouts** that actually work — report cards, receipts, ID cards, admit cards, TCs, mark sheets. Schools print constantly.

> ### GATE 8
> - Lighthouse ≥90 performance / ≥95 a11y on the main dashboard.
> - Offline attendance marking survives airplane mode and syncs correctly.
> - Every Phase-3 module has a complete, polished screen.

---

# PHASE 9 — Mobile app (parents + teachers)

~6–8 weeks. Expo 54 / RN 0.81 skeleton exists.

1. **Parent app**: child dashboard (multi-child switcher), attendance, marks/report cards, fee dues + **pay in app**, homework, announcements, PTM booking, leave application, bus tracking (if transport), document downloads, direct message to class teacher.
2. **Teacher app**: mark attendance (offline-first), enter marks, homework upload, class list, leave request, substitutions, announcements.
3. Push notifications with deep links.
4. Biometric app lock (child data on a parent's phone).
5. Offline-first with an outbox queue.
6. Store presence: iOS + Android release, **school-branded builds** for big chains (white-label via Expo config plugins + EAS) — chains will ask for their own app icon and name, and charging for it is good business.
7. Play Store data-safety and App Store privacy declarations — be accurate about children's data.

> ### GATE 9
> - Both apps in TestFlight / Play internal testing.
> - Fee payment works end-to-end on a real device.
> - One white-label build produced from config alone.

---

# PHASE 10 — India compliance and board specifics

~5–7 weeks. **This is what separates a sellable ERP from a project.** Start the reading early; the build is small but the requirements are exact.

### 10.1 DPDP Act 2023 (Digital Personal Data Protection)
Students are minors, which puts you in the strictest category the Act defines.
1. **Verifiable parental consent** for processing children's data; consent records with purpose, timestamp, and withdrawal path.
2. **No behavioural advertising or tracking of children.** Keep third-party analytics off student-facing surfaces entirely.
3. Data-principal rights: access, correction, erasure, grievance redressal with a named officer and SLA.
4. **You are a Data Processor; the school is the Data Fiduciary.** You need a **Data Processing Agreement** in every contract — and schools' lawyers will ask for it.
5. Breach notification process and rehearsed timeline.
6. Purpose limitation, retention schedules, and automated deletion.
7. **Verify the current status of the DPDP Rules and their compliance deadlines with an Indian privacy lawyer before you sign your first contract.** The Act passed in 2023 and the operative rules and phase-in timelines have been moving; do not rely on this document (or me) for the current legal position.

### 10.2 Government reporting
1. **UDISE+** — annual school data return. Build an export that matches the current format; every recognised school must file it, and doing it for them is a genuine reason to buy.
2. **APAAR / ABC ID** — student unique-ID linkage; store and validate the identifier.
3. State board portals vary; build an export framework, not one-off scripts.
4. RTE 25% quota tracking and reporting.

### 10.3 Board-specific academics
1. **CBSE**: report card formats per class band, A1–E grading, CGPA, co-scholastic areas, internal assessment split, registration/LOC data export.
2. **ICSE/ISC**: different mark structure and formats.
3. **State boards**: configurable — this is why 2.6 makes report cards template-driven.
4. **Certificates**: Transfer Certificate (numbered, board-specific wording), bonafide, character, migration, fee-payment certificate, ID cards, admit cards. Small feature, constant demand.

### 10.4 Financial and statutory
1. GST on your SaaS invoices (18%), correct SAC code, e-invoicing if you cross the threshold.
2. If you do school payroll: PF, ESI, professional tax, TDS with Form 16 inputs. Optional module — say clearly whether you support it, because half-supporting payroll creates liability.
3. Data localisation: host in an **India region** (AWS Mumbai / GCP Delhi-Mumbai / Azure Central India). Say so in your sales deck; it closes objections.

> ### GATE 10
> - UDISE+ export validates against the current format.
> - CBSE report card, byte-for-byte acceptable to a real school's coordinator (get one to review it).
> - DPA template reviewed by a lawyer.
> - Consent + erasure flows implemented and tested.

---

# PHASE 11 — Operations and reliability

~5–6 weeks. Interleave earlier where cheap — observability especially.

1. **Observability**: OpenTelemetry traces across all 12 services (essential — without distributed tracing, debugging a 12-service request is guesswork), structured JSON logs with tenant + request ID, Sentry for errors, Prometheus/Grafana or a hosted equivalent.
2. **Alerts that matter**: error rate, p99 latency, queue depth, failed payments, failed notifications, tenant migration drift, disk/connection saturation, backup failure.
3. **Backups**: automated per-tenant logical backups + cluster PITR, off-region copies, **quarterly restore drills with recorded RTO/RPO**. An untested backup is not a backup.
4. **Deployment**: Docker images per service, ECS Fargate or managed Kubernetes, blue-green or rolling with health gates, one-command rollback, DB migrations decoupled from app deploy (expand → deploy → contract).
5. **Environments**: local (compose) → staging (full fleet, anonymised data) → production. Never test migrations first in production.
6. **PgBouncer** deployed and tuned per ADR-2, with connection-count dashboards.
7. **Load test**: 50 schools × 2,000 students; the morning attendance spike (8:00–8:30 is your peak, every day, all at once); fee-deadline day; result-publication day. Fix what breaks.
8. **Runbooks**: tenant provisioning failure, migration failure mid-fleet, payment reconciliation mismatch, restore single tenant, rotate secrets, gateway outage. Write them before you need them at 11pm.
9. **Status page** + incident comms templates. Schools tolerate downtime far better than silence.
10. **Cost model**: per-tenant infra cost so you know your gross margin per school. Track it from tenant #1.

> ### GATE 11
> - Load test passes at target scale with p95 under 500ms.
> - Single-tenant restore drill completed and timed.
> - Every alert has a runbook link.

---

# PHASE 12 — Security hardening and external validation

~4–5 weeks. Do this **before** the first paying customer, not before the first pilot.

1. **Threat model** (STRIDE) with cross-tenant leakage as threat #1.
2. **Automated isolation test suite** run on every PR, covering every endpoint (extends 0.7.4). This is your most valuable security asset — treat a leak as a P0 with a post-mortem.
3. **OWASP ASVS Level 2** self-assessment: authz on every object reference (IDOR is the classic ERP bug — `GET /students/:id` must verify the student belongs to the caller's tenant *and* branch scope), SSRF on file fetches, XSS in rich-text announcements, SQL injection in any raw query, upload validation + virus scanning, path traversal.
4. **Secrets management**: KMS/Secrets Manager, rotation, no secrets in env files in production, encrypted tenant connection strings.
5. **Encryption**: TLS 1.3 everywhere, at-rest encryption, column-level encryption for the most sensitive fields (Aadhaar-adjacent identifiers, medical notes, guardian phone if required).
6. **Dependency and container scanning** in CI; SBOM.
7. **Third-party VAPT** (vulnerability assessment and penetration test). Indian schools and especially chains ask for a VAPT certificate in procurement. Budget ₹50k–₹2L. Remediate and get a retest letter.
8. **Security questionnaire pack**: architecture diagram, data-flow diagram, encryption summary, access-control policy, incident response, sub-processor list, backup/DR summary, DPA. Assemble once; reuse in every deal.
9. Consider **SOC 2 Type 1** or **ISO 27001** only when a specific large deal requires it — expensive and premature otherwise.
10. **Responsible disclosure** page and a security@ address.

> ### GATE 12
> - VAPT report with all high/critical findings remediated and retested.
> - Isolation suite covers 100% of endpoints.
> - Security pack assembled.

---

# PHASE 13 — Go to market

~6–8 weeks, overlapping Phase 11–12. Software that no one buys is a hobby.

### 13.1 Pricing (typical Indian market shape — validate locally)
- **Per student per year** is the dominant model. Roughly ₹150–₹600/student/year depending on modules, with volume tiers; premium for mobile app white-labelling, biometric integration, and multi-branch consolidated analytics.
- Messaging (SMS/WhatsApp) passed through as credits.
- One-time onboarding/data-migration/training fee — **charge for this**. It's real work and it filters out non-serious prospects.
- Payment-gateway charges borne by the school or the parent (convenience fee) — decide explicitly and document it.
- Annual contracts billed up front where possible; Indian schools' budget cycles align to the April academic year, so **sell Jan–March**.

### 13.2 Sales assets
1. **A demo tenant with realistic, beautiful data** — 3 branches, 1,200 students, a full year of attendance, real-looking report cards. Never demo on empty tables. This is the highest-ROI thing in this section.
2. A 20-minute demo script hitting: multi-branch consolidated dashboard → attendance in 30 seconds → auto report card → fee collection + online payment → parent app on a real phone.
3. Module one-pagers, comparison sheet vs the incumbents you meet, ROI calculator (hours saved in the accounts office, fee-collection-rate improvement).
4. Case study from pilot #1 with actual numbers. Get permission in writing.
5. Website with pricing, security page, and a request-demo form.

### 13.3 Onboarding machine
The main reason school ERP deals die is data migration. Industrialise it:
1. Excel templates for students, staff, fees, marks.
2. The import tool from 3.2/6.3 with a mapping UI.
3. A documented onboarding checklist: kickoff → data collect → import → configure (fees, grading, calendar) → train admin → train teachers → parent app rollout → go-live → 30-day check-in.
4. Training: role-based videos (5-min each), printable quick-reference cards in English and Hindi, in-app tours.
5. **Parent app adoption campaign** — this is where pilots visibly succeed or fail. Aim for >70% of parents installed within 30 days, and measure it.

### 13.4 Support
1. Ticketing (Freshdesk/Zoho), WhatsApp support line (Indian schools will use WhatsApp regardless of what you set up), defined SLAs by severity.
2. Support access via time-boxed, audited `support_grant` — never a shared admin password.
3 Status page, changelog, in-app release notes.
4. Escalation path and your own on-call reality check: **you are the on-call rotation.** Decide what you'll answer at 7am on results day.

### 13.5 Contracts and legal
1. MSA + DPA + SLA + AUP. Get a lawyer; do not use a US SaaS template unmodified for India.
2. Uptime commitment you can actually meet (99.5% is honest for a solo operation; 99.9% is not, initially).
3. Data ownership and exit clause — "your data is yours, exportable any time." Then honour it with 1.5.4.
4. Liability caps, indemnities, and insurance (professional indemnity / cyber). Children's data raises the stakes.

---

# PHASE 14 — Pilot to scale

1. **Pilot: 1–2 friendly schools, free or heavily discounted, in writing as a pilot with feedback obligations.** Prefer one single-branch and one multi-branch. Visit in person; watch the front-office clerk use it. You will learn more in one morning than in a month of planning.
2. Instrument everything: feature usage, time-on-task, support ticket themes, parent app adoption. Fix the top 5 friction points before selling.
3. **First paying customers: target 5.** This is where you find out whether onboarding is repeatable.
4. Then 25. At this point revisit: PgBouncer headroom, migration fan-out time, support load, and whether the 12-service split is helping or taxing you. Re-evaluate honestly with data.
5. Hire when support eats >40% of your week — first hire is onboarding/support, not a developer.

---

## Deferred backlog (do not build until a paying customer asks)

Hostel · inventory/asset management · online classes (integrate Zoom/Meet, don't build video) · alumni portal · biometric device integration · GPS bus tracking · CCTV integration · visitor management · canteen/cashless cards · e-learning/LMS · question-bank and online exams · smart-board integration.

Each of these is a real module in competitor feature lists. None of them close a deal on their own. Attendance, fees, report cards, and the parent app do.

---

## Ordered summary — the one-line version

| # | Phase | Weeks | Why it's here |
|---|---|---|---|
| 0 | Repo safety + auth fixes | 2–3 | Everything else builds on it |
| 1 | Multi-tenant control plane | 4–6 | Onboard school #2 without code |
| 2 | Domain model redesign | 5–7 | Last moment it's free to change |
| 3 | Core services buildout | 10–14 | The actual product |
| 4 | Payments + SaaS billing | 3–4 | Revenue, both directions |
| 5 | Communication (WhatsApp/SMS/DLT) | 3–4 | What parents notice |
| 6 | Go services made real | 4–5 | Timetable is a killer demo |
| 7 | Analytics + AI | 4–6 | Needs real data first |
| 8 | Frontend maturity | 8–10 | Runs parallel with 3 |
| 9 | Mobile parent/teacher app | 6–8 | Drives renewals |
| 10 | India compliance + boards | 5–7 | Separates product from project |
| 11 | Ops + reliability | 5–6 | Survive 50 schools |
| 12 | Security + VAPT | 4–5 | Required in procurement |
| 13 | Go to market | 6–8 | Overlaps 11–12 |
| 14 | Pilot → 5 → 25 customers | ongoing | The real test |

**Critical path if you want revenue soonest:** 0 → 1 → 2 → 3(identity, student, attendance, fee, exam) → 4 → 5 → 8(partial) → 9(parent app) → 10(DPDP + CBSE report card) → 12(VAPT) → 13 → pilot. Phases 6, 7, and the deferred backlog can all wait.

**The three things most likely to sink this:** (1) shipping before the enrollment-history fix in 2.2; (2) a cross-tenant data leak; (3) underestimating data migration during onboarding. Guard those three above all else.
