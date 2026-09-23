# Backups — what runs, where it lands, how to restore

Nightly, automatic, and verified. Set up 2026-09-20; dual-mode (Docker +
host) 2026-09-23.

## Two modes, picked automatically

`scripts/backup.sh` detects which deployment it is running against
(override with `BACKUP_MODE=docker` or `BACKUP_MODE=host`):

| | **docker mode** (docker-compose.app.yml deploy) | **host mode** (Windows/dev box) |
|---|---|---|
| Databases | `pg_dump` **inside the postgres container**, streamed to `backups/db/` on the host | host `pg_dump` against `DATABASE_URL` |
| Files | tarred **through** the running staff-service / provision-service containers (the named volumes) | tarred from `apps/*/data` on disk |
| Trigger | host cron: `30 2 * * * /bin/bash /opt/educore/scripts/backup.sh` | Windows Task Scheduler "EduCore Nightly Backup" 02:30 |

Everything else is identical: DB discovery pattern `^(school_erp\|tenant_)`
(new tenant DBs picked up automatically), `pg_restore -l` integrity gate at
dump time, 14-night retention, optional `BACKUP_COPY_TO` second destination,
non-zero exit on any failure, optional Pushgateway metric.

## What is backed up

| What | Where it lands |
|---|---|
| Every ERP-owned Postgres DB — control plane + all tenants (pattern `^(school_erp\|tenant_)`; other projects and Prisma shadow/scratch DBs excluded) | `backups/db/<dbname>.dump` (custom format, ~4.5 MB total today) |
| Uploaded files — photos, documents (staff-service) + logos (provision-service), from the volumes on Docker or `apps/*/data` on the host | docker: `backups/files/<service>-data-YYYY-MM-DD.tar.gz` (one per service) · host: `backups/files/uploads-YYYY-MM-DD.tar.gz` |

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

### Docker deployment

```bash
cd /opt/educore

# A database (verify first, always):
docker compose -f docker/docker-compose.app.yml exec -T postgres pg_restore -l /dev/stdin < backups/db/school_erp.dump

docker compose -f docker/docker-compose.app.yml exec -T postgres \
  psql -U postgres -c 'CREATE DATABASE restored_scratch'
docker compose -f docker/docker-compose.app.yml exec -T postgres \
  pg_restore -U postgres -d restored_scratch /dev/stdin < backups/db/school_erp.dump
# inspect, then swap: rename the old DB out, restored_scratch in, restart services

docker compose -f docker/docker-compose.app.yml exec -T postgres \
  psql -U postgres -c 'DROP DATABASE restored_scratch'
```

**Files** — one tarball per service volume; the stream lands INSIDE the
container's data dir (where the volume is mounted):

```bash
tar -xzOf backups/files/staff-service-data-YYYY-MM-DD.tar.gz \
  | docker compose -f docker/docker-compose.app.yml exec -T staff-service \
      tar -xzf - -C /repo/apps/staff-service/data
tar -xzOf backups/files/provision-service-data-YYYY-MM-DD.tar.gz \
  | docker compose -f docker/docker-compose.app.yml exec -T provision-service \
      tar -xzf - -C /repo/apps/provision-service/data
```

### Host (Windows/dev) deployment

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
