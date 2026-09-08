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
| `packages/auth`, `config`, `database`, `shared-types`, `testing` | Shared libraries. |
| Tests | **74 passing** (`vitest`): `packages/auth` (29 — assertions + token lifecycle), `packages/config` (22 — env), `student-service` (23 — auth endpoints + student CRUD + **forged-header 401** + **cross-tenant isolation suite**). The thin services are `passWithNoTests` until Phase 3 rebuilds them. |
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
- Rate-limiter and token-store are **in-memory** in single-process dev. `RedisTokenStore` ships in `@school-erp/auth`; wiring it (and `rate-limit-redis`) happens in Phase 1 when instances multiply.
- WebSocket auth in the Go `notification-engine` stub is query-parameter only; the Phase 6 rewrite brings assertion-based auth.

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
│   ├── database/                # Prisma schema, migrations, seed
│   ├── shared-types/            # TypeScript contracts
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

See `docs/BUILD_PLAN.md` for the current phase ("start from Phase 0's gate"). Every route touched ships with a test. If a test would be hard to write, that is a symptom to raise, not a shortcut to take.

## License

ISC
