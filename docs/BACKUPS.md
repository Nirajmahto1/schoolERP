# Backups — what runs, where it lands, how to restore

Nightly, automatic, and verified. Set up 2026-09-20.

## What is backed up

| What | Where it lands |
|---|---|
| Every ERP-owned Postgres DB — control plane + all tenants (pattern `^(school_erp\|tenant_)`; other projects and Prisma shadow/scratch DBs excluded) | `backups/db/<dbname>.dump` (custom format, ~4.5 MB total today) |
| Uploaded files — `apps/staff-service/data` (photos, documents) + `apps/provision-service/data` (logos) | `backups/files/uploads-YYYY-MM-DD.tar.gz` |

New tenant databases are picked up automatically — nothing is hardcoded to
today's list. Every dump is integrity-gated with `pg_restore -l` at creation
time; the script exits non-zero if anything failed, and every run appends to
`backups/backup.log`.

**Retention:** 14 nights (`RETENTION_DAYS` in `scripts/backup.sh`).

## Schedule

Windows Task Scheduler task **"EduCore Nightly Backup"** — daily 02:30,
runs as `niraj`.

- It runs when your Windows session exists (locked screen is fine). Powered
  off or fully logged out = that night is skipped.
- Change the time:
  `schtasks /Change /TN "EduCore Nightly Backup" /ST 03:30`
- Make it run even when logged out (asks for your Windows password once):
  `schtasks /Change /TN "EduCore Nightly Backup" /RU niraj /RP <password>`
- Trigger a run manually right now:
  `schtasks /Run /TN "EduCore Nightly Backup"` (or just `bash scripts/backup.sh`)

## Restoring

**A database** (verify first, always):

```bash
pg_restore -l backups/db/school_erp_setup.dump        # integrity check
createdb -h localhost -U postgres restored_setup      # empty target
pg_restore -h localhost -U postgres -d restored_setup backups/db/school_erp_setup.dump
```

**Uploaded files** (archive stores paths relative to the repo root):

```bash
tar -xzf backups/files/uploads-YYYY-MM-DD.tar.gz -C D:/FinalPlan/Projects/schoolERP
```

## Proven, not assumed (2026-09-20)

- `school_erp_setup` dump restored into a scratch DB: **81 tables, 33 users,
  12 students — identical to source**; scratch dropped after.
- The scheduled task's own invocation path was executed end-to-end
  (`schtasks /Run`) — `failed=0`, 23 s.

## Off-machine copies — the recommended next step

These backups live on the same disk as the data: they survive a bad deploy or
an accidental `DELETE`, but not disk death. Set `BACKUP_COPY_TO` in `.env`
(e.g. an external drive `E:/educore-backups` or a synced OneDrive folder) and
every run also copies the fresh artifacts there automatically.
