# Phase 11 — Operations & reliability: evidence log

**Completed:** 2026-09-21. This file records what was built and measured, so
the Gate 11 conversation starts from facts.

## 11.1 Observability — done

- **Prometheus `/metrics` on every service** (zero-dependency, no prom-client):
  - Node (gateway + 9 services): RED metrics — `http_requests_total`,
    `http_request_duration_seconds` (histogram), route labels normalised
    (`/students/:id`) to bound cardinality, plus process memory/uptime/event-loop
    gauges. Implemented once in `packages/http/src/metrics.ts` and wired via the
    shared bootstrap (`packages/auth/src/bootstrap.ts`) + the four hand-rolled
    app factories (student, exam, identity, provision).
  - Python (analytics): `/metrics` with uptime/RSS/pool gauges (stdlib only).
  - Go (notification-engine, timetable-engine, bulk-processor): runtime +
    engine-specific gauges (`ws_sockets_connected` on the notification engine).
- **Structured JSON request logs** — one line per request with
  `service, method, path, status, duration_ms, request_id, tenant_id,
  branch_id, user_id`. Identity fields come from the verified assertion, never
  raw headers. Gateway keeps morgan for humans; services emit JSON for sinks.

## 11.2 Alerts — done

`docker/alerts.yml` (loaded by prometheus.yml): ServiceDown (page), HighErrorRate
>5% (page), HighP99Latency >500ms (warn), MemoryPressure, EventLoopLag,
DiskNearlyFull (page), FailedPayments — fee-service 5xx >2% (page),
FailedNotifications (warn), BackupFailed (`educore_backup_success == 0`, page),
MigrationDrift (`tenant_migration_drift > 0`, warn). **Every alert links to a
runbook anchor** (GATE 11 criterion #3).

- `scripts/backup.sh` now pushes `educore_backup_success` +
  `educore_backup_duration_seconds` to a Pushgateway when `BACKUP_PUSHGATEWAY`
  is set — the backup failure alert has a real signal, not a placeholder.
- `scripts/uptime-check.mjs` polls the gateway status every 5 minutes
  (schedulable via schtasks/cron) and posts to `STATUS_WEBHOOK_URL` on change.

## 11.3 Backups — done (earlier) + hardened

Nightly 02:30 dumps of every ERP database + file tarball, restore-verified,
14-night retention (docs/BACKUPS.md). This phase added the failure metric hook
above. Restore drill record: `school_erp_setup` rebuilt into scratch — 81
tables / 33 users / 12 students, byte-identical counts (2026-09-19, ~35s).

## 11.4/11.5 Deployment & environments — done

- `docker/Dockerfile.service` — one parameterised multi-stage build for every
  Node service (builder: turbo build + `npm prune --omit=dev`; runtime:
  non-root `educore` user, healthcheck on `/health`).
- `docker/docker-compose.staging.yml` — adds **pgbouncer** (transaction pooling,
  ADR-2), **prometheus** (scrapes the whole fleet), **grafana** (auto-provisioned
  datasource). Local dev compose was already present; staging is the full
  operational plane on top of it.

## 11.6 PgBouncer — deployed

Container + tuned defaults (transaction mode, max_client_conn=500,
default_pool_size=20) in the staging overlay. Services point at it by swapping
the DB host/port in their env — no code change.

## 11.7 Load test — run, bottleneck found and fixed

`scripts/load-test.mjs` simulates the three real spikes: morning attendance
(8:00–8:30), fee-deadline day, result-publication day. GATE 11 target p95<500ms.

Against the live stack through the gateway (setup tenant, 60 VUs × 25s):

| Run | Change | p95 (3 scenarios) | Errors |
|---|---|---|---|
| 1 | — | 138 / 146 / 92 ms | 7693/7836, 10251/10251, 12655/12696 — **429s** |
| 2 | env-tunable rate limits (`RATE_LIMIT_*_PER_MIN`) | 793 / 721 / 821 ms | 0 |
| 3 | `ANALYTICS_POOL_SIZE` 5→25 | 490 / 453 / 510 ms | 0 |
| 4 | analytics `--workers 2` | 507 / 562 / 457 ms | 4 (transient) |

Findings, honestly:

1. Run 1 "failed" only because the gateway's rate limiter did exactly its job
   (identity-keyed 300 reads/min). Limits are now env-tunable with safe
   defaults — capacity testing no longer measures the abuse brake.
2. Serial latency is excellent (26–48ms per endpoint). The concurrency ceiling
   was the **analytics connection pool (5)** — the classic bottleneck. Fixed by
   sizing the pool for the deployment (PgBouncer makes larger pools safe).
3. p95 now sits **at** the 500ms line on a dev-mode stack (ts-node-dev, no
   compilation caching, local Postgres, laptop-class disk). The compiled/Docker
   staging deployment is expected to clear it with margin — verify there before
   declaring the gate passed.

## 11.8 Runbooks — done

`docs/ops/RUNBOOKS.md`: an entry for every alert plus the six plan scenarios
(provisioning failure, migration failure mid-fleet, payment reconciliation
mismatch, single-tenant restore with quarterly RTO/RPO record table, secret
rotation, gateway outage), status-page comms templates (first post ≤10min,
30-min updates, resolution + blameless post-mortem), and the per-tenant cost
model (§11.10: infra ≈1–3% of revenue at target pricing).

## Status page — done

`GET /status` on the gateway aggregates every upstream's `/health` in parallel
(2.5s timeout), returning `operational | partial-outage | major-outage` with
per-service latency. Verified live: 13/13 `up`, HTTP 200. Deliberately
unauthenticated (exposes only alive/degraded), `cache-control: no-store`.

## Gate 11 checklist

| Criterion | State |
|---|---|
| Load test passes at target scale with p95 under 500ms | **At the line on dev hardware** (507/562/457ms, 0% errors). Needs a staging-hardware run to declare passed. |
| Single-tenant restore drill completed and timed | ✅ 2026-09-19, ~35s RTO, <24h RPO (recorded in RUNBOOKS table) |
| Every alert has a runbook link | ✅ `docker/alerts.yml` → `docs/ops/RUNBOOKS.md#…` |

## To finish after this phase

- Boot prometheus+grafana via the staging compose against a running fleet and
  keep one dashboard per service type (RED + saturation).
- Register `scripts/uptime-check.mjs` in Task Scheduler (5-min cadence).
- Re-run the load test against the compiled/Docker staging deployment; record
  the numbers in the RUNBOOKS drill table to close Gate 11 fully.
