# Operations Runbooks (Phase 11.8 / GATE 11)

> Every alert in `docker/alerts.yml` links to an anchor here. Write the runbook
> before you need it at 11pm — future-you has no context and no patience.

**Severity contract:** `page` = wake a human now. `warn` = fix within the day.
**First 5 minutes, every incident:** open `.setuprun/*.log` (or container logs),
check `/status`, check the last deploy, check disk space. Then read the entry.

---

## Alert runbooks

### Service down {#service-down}
**Fires when:** a service stops answering `/metrics` for 2 minutes.
1. `curl -s http://localhost:<port>/health` on the reported port — confirm it is really down, not a metrics scrape hiccup.
2. Check the process: PM2/Docker/host logs. The last 30 lines almost always name the cause (port bind failure, OOM kill, unhandled rejection).
3. Restart the service. If it crash-loops, that is a different incident: freeze the restart loop and debug from the log — do not mask it with a supervisor's retry.
4. If the machine is out of memory, stop the least-critical service (bulk-processor first, then ai-service) to keep the money paths (fee-service) alive.
5. Post to the incident channel: what is down, since when, what you are doing (template below).

### High error rate {#high-error-rate}
**Fires when:** a service's 5xx share exceeds 5% for 5 minutes.
1. Find the route: query `http_requests_total{job="<svc>",status=~"5.."}` by `route` in Prometheus. One route = a code/contract bug; everywhere = a dependency.
2. If one route: read the structured JSON log lines for its request_ids (`request_id` correlates across services). Recent deploy? Roll back first, debug after.
3. If everywhere: check `/ready` on the service — a failing DB check means Postgres/PgBouncer, not the service. Follow [PgBouncer saturation](#pgbouncer-saturation) if pool metrics are maxed.

### High p99 latency {#high-p99-latency}
**Fires when:** p99 > 500ms for 10 minutes (also covers event-loop lag).
1. Identify the slow route the same way as error rate.
2. Node services: event-loop lag gauge high ⇒ CPU-bound work on the main thread (PDF rendering, big Excel imports). The Go bulk-processor exists for exactly this — move the job there.
3. DB-bound: check PgBouncer pools and `pg_stat_activity` for long queries. Missing index after a data change is the usual suspect.
4. Attendance window (08:00–08:30): some latency here is expected; the gate is p95 < 500ms under the load-test profile, not zero.

### Memory pressure {#memory-pressure}
**Fires when:** RSS > 1.5GB for 10 minutes.
1. Confirm with the process metrics trend, not the instantaneous value.
2. Usual cause: a streaming endpoint that buffered (import preview on a huge file, batch PDFs). Restart the service to reclaim; then fix the buffer.
3. If recurring without an obvious route, capture `--inspect` heap snapshot in staging before restarting.

### Disk nearly full {#disk-nearly-full}
**Fires when:** root filesystem < 15% free.
1. First, stop the bleeding: old backups (keep 14 nights — pruning runs nightly), `.setuprun/*.log`, container logs, npm caches.
2. Photos/documents live in `apps/staff-service/data` — never delete these; they are the tenant's records and are in the nightly tarball.
3. After freeing, verify the nightly backup still has room; a backup that fails on disk space is the classic second incident.

### Payment reconciliation mismatch {#payment-reconciliation-mismatch}
**Fires when:** fee-service error rate > 2% (payment capture at risk).
1. Do NOT restart fee-service mid-investigation if avoidable — the reconcile job recovers dropped webhooks on its own.
2. Check the ledger: `POST /api/v1/fees/reconcile/run` re-polls Razorpay for INITIATED payments; anything captured at the bank but INITIATED here gets claimed by the race-safe path.
3. Compare `payments` rows with the Razorpay dashboard for the window. A double-credit should be impossible (idempotent claim on the payment row) — if you see one, freeze writes to that invoice and pull the audit rows; this is a P0.
4. Refunds: verify the reversal ledger entries exist for any refund in the window.

### Failed notifications {#failed-notifications}
**Fires when:** communication-service or notification-engine error rate > 5%.
1. Attendance absence alerts are the time-critical flow (Gate 5: within 2 minutes of marking). If those are failing, say so in the incident post — schools notice this one fastest.
2. Provider outages are the most common cause: check the BSP/SMS/email provider status page before debugging code. The dispatcher's fallback chain (WhatsApp → SMS → push → email) should absorb single-provider loss — if one provider is down, confirm the others are carrying the traffic (delivery counts per channel).
3. Queue depth (dispatcher backlog) growing while error rate is normal = upstream slowness, not failures. Increase visibility first, act after.

### Backup failed {#backup-failed}
**Fires when:** `educore_backup_success == 0` (the nightly script pushed a failure).
1. Read `backups/backup.log` — the failing step (dump / verify / tar / copy) is logged per database.
2. Most common: disk space (see above), then Postgres auth (password change), then a new DB matching the exclude pattern unexpectedly.
3. After fixing, re-run manually and confirm exit 0 and fresh artifacts. A failed backup night is a 24-hour RPO hole — record it in the incident log with the recovery action.

### Migration failure mid-fleet {#migration-failure-mid-fleet}
**Fires when:** `tenant_migration_drift > 0` (provisioning-service drift-check).
1. Identify drifted tenants: `npm run tenant:drift-check` lists them.
2. `npm run tenant:migrate` applies the pending migration to the named tenant; apply to the drift list one at a time, checking the service log after each.
3. NEVER hand-edit a tenant schema to silence the alert — that hides divergence from the baseline, which is exactly what the drift check exists to catch.
4. If a migration itself failed partway: follow `docs/ops/phase7-decisions.md` (expand→deploy→contract). Contract steps must not run until every tenant is past the expand+deploy stages.

### Gateway outage {#gateway-outage}
1. If the gateway is down, everything is unreachable even when services are healthy — say that explicitly in status comms ("API down, data safe, services healthy").
2. Restart the gateway process. It is stateless (JWT + proxies) and comes back in seconds.
3. While down, staff attendance moves to the office kiosk fallback; fee capture pauses but Razorpay checkout intents complete server-side and reconcile.

### Tenant provisioning failure {#tenant-provisioning-failure}
1. Provisioning is transactional by design: a failed `tenant:create` leaves no half-created tenant — check `provision_audit` for the attempt row.
2. Common causes: name collision (409, pick another slug), DB-create permission loss, migration failure on the fresh DB.
3. After fixing the cause, re-run `tenant:create` with the same slug; it resumes cleanly.

### Rotate secrets {#rotate-secrets}
1. Inventory: `.env` (JWT secrets, assertion keypair, Razorpay, BSP keys, DB password). Where a value lives in a provider dashboard too, rotate there first.
2. Assertion keypair: generate with `npm run keygen`, deploy the public key to all services, then swap the gateway's private key. Both keys verify during the overlap — no downtime.
3. JWT secrets: rotating invalidates all sessions. Do it in a window; expect a support blip as everyone logs in again.
4. DB password: change in Postgres, then `.env`, then restart services — and update PgBouncer's userlist if deployed.
5. Never reuse placeholder values; the config loader refuses them anyway.

### Restore single tenant {#restore-single-tenant}
1. Pick the dump: `backups/db/<db>_<date>.dump` (nightly) — newest before the data-loss point.
2. Dry-run to scratch: `pg_restore -h localhost -U postgres -d scratch_restore --no-owner <dump>`; verify table/row counts against the live DB.
3. Scheduled drill (record RTO/RPO each quarter in the table below):
   `npm run tenant:restore-drill -- --file backups/db/<db>.dump`
4. Swap only after verification: rename live aside, rename restored in, restart the tenant's services. Keep the aside-copy for a week.
5. RPO by construction: nightly ⇒ worst case ~24h of the day's writes. If a school needs better, promote them to a more frequent schedule; do not silently promise it.

---

## Restore drills — quarterly record (Gate 11)

| Date | Tenant/DB | Dump age | RTO | RPO | Verifier | Notes |
|---|---|---|---|---|---|---|
| 2026-09-19 | school_erp_setup | < 1 day | ~35s | < 24h | Buffy + scripted counts | 81 tables / 33 users / 12 students matched source |
| | | | | | | |

---

## Status page + incident comms templates (Phase 11.9)

**Live status:** the gateway's `GET /status` aggregates every service's health —
the uptime cron (`scripts/uptime-check.mjs`, every 5 minutes) alerts the webhook
on change. During an incident, update this in the channel, not in a doc.

**First post (≤10 minutes from detection):**
> **Incident — <what is affected, e.g. "fee payments / attendance marking">**
> Detected <time>. Impact: <one sentence, parent-visible terms>. Status: investigating; next update by <time+15m>.

**Update (every 30 minutes, even if nothing changed):**
> <What we know now. What we are doing. Still investigating / fix in progress / monitoring. Next update by <time>.>

**Resolution:**
> Resolved at <time>. Cause: <one sentence, honest>. Data impact: <none / what and how compensated>. Follow-up: <link to the post-mortem, due <date>>.

**Post-mortem (within 3 working days, blameless):** timeline, contributing causes, what made detection slow, and the tracked fix items. Post-mortems are shared with affected schools on request — that honesty is a sales asset.

---

## Cost model per tenant (Phase 11.10)

Per-school infra cost on a single VPS (current deployment shape, ~USD/INR):

| Item | Cost/month | Per-tenant share at 10 schools | Notes |
|---|---|---|---|
| VPS 8GB/4vCPU (Hetzner/DO Mumbai) | ₹1,400 | ₹140 | Production would run ~2 nodes for headroom |
| PostgreSQL storage + backups | ₹300 | ₹30 | Nightly dumps ×14 + file tarballs |
| Object storage (photos/documents) | ₹150 | ₹15 | Scales with enrollment; ~₹1–2/school-month at 1k students |
| WhatsApp BSP + SMS (variable) | usage | usage | ~₹0.30/WhatsApp conversation, ~₹0.15/SMS — passes through to pricing |
| Razorpay | 2% MDR | pass-through | On collected fees only |
| Domain/TLS/monitoring | ₹100 | ₹10 | Amortised |

**Infra gross margin at ₹150–₹600/student/year with 1,000 students/school:**
infra ₹185–₹400 per school per month against revenue ₹12,500–₹50,000 per school
per month-equivalent ⇒ **infra cost is 1–3% of revenue**. The real costs are
support time and acquisition — the model exists so a price cut debate starts
from numbers, not vibes. Recompute after the fleet exceeds one node.
