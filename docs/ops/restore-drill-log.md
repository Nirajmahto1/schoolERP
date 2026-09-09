# Single-Tenant Restore Drill Log

BUILD_PLAN 1.5.5: "Restoring one school without touching the other 99 is the drill
that matters; run it quarterly and record the time." GATE 1 requires the drill
rehearsed and timed. Each entry below is a **rehearsed** restore of one tenant
into a scratch database on the same cluster — the original tenant is never
touched, and the scratch database is dropped after verification.

## How to run one

```bash
# 1. Backup one tenant (pg_dump custom format)
npm run tenant:backup -- --tenant-id <id> --out ./backups

# 2. Rehearse the restore: scratch DB → verify → drop scratch
npm run tenant:restore-drill -- \
  --file ./backups/<tenant>.dump \
  --probe-table schools --probe-count 1
```

- **RTO (recovery time objective):** `durationMs` from the drill — wall-clock
  restore + verification for one tenant.
- **RPO (recovery point objective):** the age of the backup at drill time —
  `dumpedAt` vs `restoredAt`. Keep this under your contractual window; it is
  governed by backup frequency, not by the drill.

---

## Drill 001 — 2026-09-09 (local dev cluster)

| Field | Value |
|---|---|
| Tenant | `dps-noida` (`tenant_dps_noida`) |
| Backup file | `tenant_dps_noida.dump` |
| Backup size | 76,371 bytes |
| Tables restored | 31 |
| Data verified | `schools` → 1 row (probe-count 1) |
| **RTO** | **660 ms** (0.7 s) restore + verify |
| **RPO** | **9 s** (backup taken immediately before the drill) |
| Scratch database | `restore_drill_*` — created and dropped; 0 left behind |
| Original tenant | untouched; `schemaVersion` still 1 |
| Command | `tenant:backup --tenant-id <dps-noida>` → `tenant:restore-drill --file <dump> --probe-table schools --probe-count 1` |

### Notes

- The drill exercises the exact production path (`pg_dump --format=custom` +
  `pg_restore --no-owner` into a fresh database). Verification is a row count
  on a known table plus a table-count sanity check.
- 0.7 s is for a tiny seeded tenant. Budget grows with data volume; re-measure
  on a real school before quoting an RTO.
- Quarterly cadence per BUILD_PLAN 1.5.5: add an entry here each quarter with
  the current tenant fleet and the largest tenant measured.