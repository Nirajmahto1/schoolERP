# School ERP

Multi-tenant school management SaaS for **India** — prototype-in-hardening, not yet sellable. Target architecture: one PostgreSQL database per school, polyglot microservices, Next.js web app + Expo mobile app. This repository is a Turborepo/NPM-workspaces monorepo.

> Read **[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md)** first. It is the design contract: phases are strictly ordered, each with an objective gate, and it contains the honest baseline of what exists today.

## What this is (honest state)

| Area | State |
|---|---|
| `apps/web` | ~30 Next.js 14 dashboard pages (shadcn). Broadest asset. |
| `apps/student-service` | **Auth + students + parents** (`/auth/login`, refresh rotation, logout, students CRUD). Most complete service. |
| `apps/staff-service`, `academic-service`, `fee-service`, `attendance-service`, `communication-service` | Thin CRUD behind the gateway. |
| `apps/analytics-service`, `ai-service` (FastAPI), `notification-engine`, `timetable-engine`, `go-service` (Go) | Stubs. Rewritten in Phases 6–7. |
| `apps/mobile` (Expo) | Skeleton. |
| `apps/provisioning-service` | **Phase 1: control plane operations** — provision (DB + role + schema + seed + MinIO storage), migrate fleet, drift-check, lifecycle (suspend/resume/delete/export), backup + restore drill. Also the `pnpm tenant:*` CLI. |
| `apps/admin-console` (Next.js) | **Phase 1: platform console** — tenant list + health, provisioning wizard, fleet migration, per-tenant management (lifecycle, billing state, migration runs, support grants, audit). |
| `packages/auth`, `config`, `database`, `http`, `shared-types`, `testing` | Shared libraries. |
| `packages/control-plane` | **Phase 1: platform registry DB** — tenants, plans, subscriptions, invoices, `user_directory` (email-hash login routing), `platform_admins`, `migration_run`, `provision_audit`, `support_grant`. |
| `packages/tenant` | **Phase 1: tenant resolution + connection routing** — subdomain/slug resolution with 60s cache, LRU per-tenant Prisma client cache (ADR-2), AsyncLocalStorage tenant context, bound client that **throws** outside a tenant context, status → 402/423 mapping. |
| Tests | **144 passing** (`vitest`): `packages/auth` (29), `packages/config` (22), `packages/http` (7), `packages/tenant` (25 — routing, LRU cache, bound-client guard, isolation), `student-service` (35 — auth + **forged-header 401** + **cross-tenant isolation suite against THREE tenants**), `provisioning-service` (26 — provisioning pipeline + idempotency + rollback, migration orchestrator, lifecycle, storage step, real-cluster role + backup/restore drill). The thin services are `passWithNoTests` until Phase 3 rebuilds them. |
| CI | GitHub Actions workflow (lint → test → build → security) included; not yet wired to a remote. |
| Git | Repo initialized; **no remote configured yet.** |

**Security posture (Phase 0 — done):**
- `POST /auth/register` is **deleted** — it used to let anyone mint a `SUPER_ADMIN` for any school. User creation is invite-only.
- Access tokens: **15 minutes**, `jti`-tracked, denylist-revocable. Refresh tokens: **30 days, rotating, reuse revokes the whole family**. `/auth/refresh` re-reads the user from the DB — a deactivated or demoted user cannot refresh into stale privileges.
- No `|| 'secret'` fallbacks anywhere. `@school-erp/config` parses every service's environment at boot and **exits the process** if a secret is missing or still a placeholder.
- No trusted plain headers. The gateway stamps every upstream hop with a **60-second RS256 (RSA-2048) assertion** (`x-internal-assertion`, audience-bound per service); every service verifies it and reads identity from `req.ctx`, never from a header. A request that hits a service port directly with forged `x-user-role: SUPER_ADMIN` gets **401**.
- CORS is an explicit allowlist (no `origin: true`). Per-route rate limits key on identity/IP. Helmet HSTS on.

Known deviations from BUILD_PLAN.md 0.5.1/0.4.3 (deliberate, tracked):
- **No JWKS HTTP endpoint.** The RSA public key is distributed via environment/secret manager instead of fetched from `/.well-known/jwks.json` — one less moving part for a small fleet. Revisit if a service needs dynamic key rotation.
- Rate-limiter and token-store are **in-memory** in single-process dev. `RedisTokenStore` ships in `@school-erp/auth`; wiring it (and `rate-limit-redis`) is deferred to a later phase when instances multiply.
- WebSocket auth in the Go `notification-engine` stub is query-parameter only; the Phase 6 rewrite brings assertion-based auth.

## Phase 1 (done): multi-tenant control plane

One Postgres cluster, **one database per school** (ADR-1), with a single control-plane registry database. `@school-erp/tenant` routes every request to the right school's database and refuses to run a query without a tenant context.

```bash
# Provision a school end-to-end: DB + least-privilege role + schema + India
# defaults (Nursery→XII, fee structures, first BRANCH_ADMIN setup link) + directory
npm run tenant:create -- --slug dps-noida --legal-name "DPS Noida"

# Fleet at a glance: tenant → schema version → drift
npm run tenant:status -- --all

# Migrate the whole fleet (bounded concurrency, recorded in migration_run, stop-on-failure)
npm run tenant:migrate -- --all
npm run tenant:migrate -- --all --dry-run

# Alert on drift: exit code 1 when any tenant is behind/ahead — cron-able
npm run tenant:drift-check          # human table + ALERT lines
npm run tenant:drift-check -- --json  # machine-readable for a cron alert

# Lifecycle
npm run tenant:suspend -- --tenant-id <id> --reason "non-payment"
npm run tenant:resume -- --tenant-id <id>
npm run tenant:delete -- --tenant-id <id> --retention-days 30
npm run tenant:hard-delete -- --tenant-id <id>
npm run tenant:export -- --tenant-id <id> --out ./exports
npm run tenant:seats -- --tenant-id <id>
npm run tenant:plan -- --tenant-id <id> --plan-code standard
npm run tenant:backup -- --tenant-id <id>
npm run tenant:restore-drill -- --file ./backups/tenant_x.dump --probe-table schools --probe-count 1
```

What Phase 1 delivered, against BUILD_PLAN:
- **1.1** `packages/control-plane` schema + committed migrations (`npm run cp:migrate`). `user_directory` stores an **email hash**, never the address. `support_grant` is the audited, time-boxed way platform staff reach a school's data.
- **1.2** Idempotent, resumable provisioning with a rollback path per step (`apps/provisioning-service/src/provision.ts`). Each tenant gets a **least-privilege Postgres role** that owns only its own database, plus (1.2.5) a **MinIO/S3 bucket + STS-scoped credentials** limited to that one bucket — best-effort and audited, so a school provisions fine when MinIO isn't configured.
  `tenant:create -- --slug <slug> --legal-name <name>` provisions all of it.
- **1.3** `@school-erp/tenant`: subdomain/`X-Tenant-Slug` resolution (60s cache), LRU `PrismaClient` cache (max 20, 10-min idle eviction, ADR-2), AsyncLocalStorage request context, and a tenant-bound client that **throws** if any query runs without a tenant bound (GATE 1).
- **1.4** Migration orchestrator: fan-out with bounded concurrency, `migration_run` records, dry-run, fleet status, stop-on-first-failure. **1.4.6 drift alerting** via `tenant:drift-check` (exit code 1 on any drift — point a cron at it).
- **1.5** Lifecycle: suspend/resume, retention-window deletion with **certificate of deletion**, per-tenant JSON export, `pg_dump` backup + rehearsed single-tenant restore drill (see [docs/ops/restore-drill-log.md](docs/ops/restore-drill-log.md) for the timed run: 31 tables restored in **0.7 s**, RPO 9 s).
- **1.6** All 7 Node services consume the shared packages (`@school-erp/auth`, `config`, `tenant`, …); the gateway mints audience-bound assertions and no service trusts `x-user-*` headers.
- **1.7** `apps/admin-console` on port 3100: tenant list + fleet drift, provisioning wizard, fleet migration, per-tenant manage page (lifecycle actions, billing/subscription, migration runs, support grants, audit trail). Sign in with a row from `platform_admins`.

GATE 1 status:
- `tenant:create` provisions a working school end-to-end in well under 2 minutes ✅ (verified live: `dps-noida`, `console-school`, `gate-check`)
- **Three tenants live locally; the isolation suite passes against all three** ✅ — `student-service` seeds three disjoint tenants (alpha/beta/gamma) and asserts every cross-tenant pair returns 404 (never 403) and lists never leak.
- `tenant:migrate --all` upgrades the fleet and reports per-tenant status ✅ (verified live with simulated drift)
- A Prisma call with no tenant context throws ✅ (tested)
- **Single-tenant restore rehearsed and timed** ✅ — see [docs/ops/restore-drill-log.md](docs/ops/restore-drill-log.md); re-run quarterly per 1.5.5.
- All 7 Node services consume the shared packages ✅

Remaining before Phase 2: nothing in GATE 1 is outstanding; the deferred items are Redis wiring (README above), live-MinIO verification (`docker:up` + one `tenant:create`), and the Phase 2 schema redesign itself.

Known issues:
- **`next build` for the admin-console fails on Next.js 16's auto-generated error pages** (`/_global-error`, `/_not-found` prerender with `TypeError: Cannot read properties of null (reading 'useContext')`) — a framework bug (vercel/next.js #84994, #86178) with no app-level workaround. `next dev` works; CI excludes the Next.js apps from build until this is fixed upstream or Next is upgraded.
- Provisioning and fleet-migration from the console run as the provisioning CLI in a child process (`src/lib/ops-cli.ts`): Turbopack bundles workspace packages into virtual paths, which breaks `child_process` spawning of the Prisma CLI in-process. The CLI is also the documented operational interface, so this keeps one code path for both.

## Prerequisites

- Node **>= 20** (developed on 24)
- PostgreSQL **16** (or `npm run docker:up`, which also starts Redis, MongoDB, MinIO)
- Redis (optional in dev, required from Phase 1)

## Quick start

```bash
# 1. Install workspace dependencies
npm install

# 2. Start infrastructure (PostgreSQL, Redis, MongoDB, MinIO)
npm run docker:up

# 3. Copy and complete environment
copy .env.example .env

# 4. Generate real secrets + the RS256 assertion keypair into .env
npm run keygen            # prints a block to paste, or:
node scripts/dev/init-local-env.cjs   # writes into .env directly

# 5. Check the machine is configured (node, env vars, DB reachability, compose files)
npm run doctor

# 6. Build shared packages (turborepo, dependency order)
npm run build

# 7. Apply database migrations
npm run db:migrate

# 8. Run a single service (from apps/api-gateway, for example)
npx turbo run dev --filter=@school-erp/api-gateway --filter=@school-erp/student-service
```

All services are expected to run behind the gateway in dev — the web app talks to `http://localhost:4000/api/v1/*` and the gateway mints an assertion per request. Hitting a service port (4001–4006) directly without an assertion returns `401`.

## Project structure

```
schoolERP/
├── apps/
│   ├── web/                     # Next.js 14 + shadcn — 30 dashboard pages
│   ├── api-gateway/             # Express — authn, assertions, CORS, rate limits, proxy
│   ├── provisioning-service/    # Phase 1 — provision, migrate fleet, lifecycle, backup
│   ├── admin-console/           # Phase 1 — platform console (Next.js, port 3100)
│   ├── student-service/         # Node + Prisma — auth, students, parents
│   ├── staff-service/           # Node + Prisma — staff, HR, payroll, transport
│   ├── academic-service/        # Node + Prisma — classes, subjects, exams, library
│   ├── fee-service/             # Node + Prisma — fee structures, invoices, payments
│   ├── attendance-service/      # Node + Prisma — daily attendance
│   ├── communication-service/   # Node + Prisma — announcements
│   ├── analytics-service/ ai-service/   # FastAPI stubs (Phase 7)
│   ├── notification-engine/ timetable-engine/ go-service/  # Go stubs (Phase 6)
│   └── mobile/                  # Expo skeleton (Phase 9)
├── packages/
│   ├── auth/                    # assertions, token lifecycle, RBAC, password policy
│   ├── config/                  # fail-fast per-service env schemas (Zod)
│   ├── control-plane/           # Phase 1: platform registry DB (tenants, plans, billing)
│   ├── database/                # tenant (per-school) Prisma schema, migrations, seed
│   ├── http/                    # error envelope, request ID, logging helpers
│   ├── shared-types/            # TypeScript contracts
│   ├── tenant/                  # Phase 1: tenant resolution, connection routing, context guard
│   └── testing/                 # test harness: keys, ephemeral schema DB, tenant seeds
├── scripts/
│   ├── doctor.mjs               # npm run doctor
│   └── dev/                     # development utilities (keys, header migration, seeds)
├── docker/                      # docker-compose(.dev).yml — infra only
└── docs/BUILD_PLAN.md           # the plan
```

## Day-to-day

```bash
npm run doctor        # preflight: env, DB, compose files
npm test              # vitest across packages + service test suites
npm run build         # tsc across the workspace in dependency order
npm run lint          # turbo lint (tsc --noEmit)
npm run db:migrate    # apply a schema change in dev (Prisma migrate dev)
npm run db:seed       # seed
npm run db:deploy     # apply committed migrations (CI / prod)
npm run keygen        # secrets/keys block for .env
```

### Test databases

Service tests create a **throwaway schema** (`test_<random>`) on whatever `DATABASE_URL` points at, run `prisma migrate deploy` into it, seed two disjoint tenants, and drop the schema when the suite ends. Point `DATABASE_URL` at a scratch database before running tests if you do not want test schemas on your dev database.

## Migrations (rules changed in Phase 0)

- `packages/database/prisma/migrations/` is **the only way the schema changes**. `prisma db push` is banned.
- Schema changes are additive → backfill → remove, so every migration is reversible on a live school.
- `0000_baseline` snapshots the current schema, generated with `prisma migrate diff --from-empty`.

## Contributing

See `docs/BUILD_PLAN.md` for the current phase (Phase 1's gate is met — move to Phase 2). Every route touched ships with a test. If a test would be hard to write, that is a symptom to raise, not a shortcut to take.

## License

ISC
