#!/usr/bin/env bash
# ──────────────────────────────────────────────
# Nightly backup — Postgres + uploaded files.
#
#   • Every non-template database on the server is dumped (custom format,
#     pg_restore-verified). New tenant DBs are covered automatically —
#     nothing here is hardcoded to today's database list.
#   • Upload roots (photos, documents, logos) are archived as one tarball.
#   • 14-night retention, applied to everything in the backup dir.
#   • All progress goes to backups/backup.log; exit code is non-zero if
#     ANY dump or archive failed, so a scheduler can alert on it.
#
# Scheduled daily 02:30 via Windows Task Scheduler ("EduCore Nightly Backup").
# Restore runbook: docs/BACKUPS.md.
# ──────────────────────────────────────────────
set -u

ROOT="D:/FinalPlan/Projects/schoolERP"
# Task Scheduler launches with System32 as cwd; node resolves modules
# relative to cwd, so anchor ourselves to the repo before anything else.
cd "$ROOT" || { echo "repo not found: $ROOT"; exit 1; }
BACKUP_DIR="$ROOT/backups"
RETENTION_DAYS=14
LOG="$BACKUP_DIR/backup.log"
STARTED=$(date +%s)

mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/files"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# ── Tool resolution (Task Scheduler's PATH is minimal) ──
if command -v pg_dump >/dev/null 2>&1; then
  PG_BIN_DIR="$(dirname "$(command -v pg_dump)")"
else
  PG_BIN_DIR="/c/Program Files/PostgreSQL/18/bin"
fi
if command -v node >/dev/null 2>&1; then
  NODE=node
else
  NODE="/c/Program Files/nodejs/node"
fi

# Only ERP-owned databases: the control plane, every tenant DB (tenant_*),
# and the school_erp* family. Excludes other projects on this server
# (finance_*, clouddeploylite) and Prisma's throwaway shadow/scratch DBs.
# Override via .env (BACKUP_DB_PATTERN) or the environment if naming changes.
ENV_PATTERN=$("$NODE" -e 'process.stdout.write(require("dotenv").config({path:"D:/FinalPlan/Projects/schoolERP/.env"}).parsed?.BACKUP_DB_PATTERN ?? "")' 2>/dev/null)
BACKUP_DB_PATTERN="${BACKUP_DB_PATTERN:-${ENV_PATTERN:-^(school_erp|tenant_)}}"
# Optional second destination (USB/cloud-sync folder): set BACKUP_COPY_TO in
# .env or the environment — every run copies the fresh artifacts there too.
ENV_COPY_TO=$("$NODE" -e 'process.stdout.write(require("dotenv").config({path:"D:/FinalPlan/Projects/schoolERP/.env"}).parsed?.BACKUP_COPY_TO ?? "")' 2>/dev/null)
BACKUP_COPY_TO="${BACKUP_COPY_TO:-$ENV_COPY_TO}"

# ── Credentials from .env — percent-decoded (URL.password is encoded) ──
ENV_JSON=$("$NODE" -e '
  const p = require("dotenv").config({ path: "D:/FinalPlan/Projects/schoolERP/.env" }).parsed || {};
  const u = new URL(p.DATABASE_URL || "");
  process.stdout.write(JSON.stringify({
    host: u.hostname, port: u.port || "5432", user: u.username,
    password: decodeURIComponent(u.password)
  }));
') || { log "FATAL: could not parse DATABASE_URL from .env"; exit 1; }

export PGHOST=$(  "$NODE" -e "process.stdout.write(JSON.parse(process.argv[1]).host)" "$ENV_JSON")
export PGPORT=$(  "$NODE" -e "process.stdout.write(JSON.parse(process.argv[1]).port)" "$ENV_JSON")
export PGUSER=$(  "$NODE" -e "process.stdout.write(JSON.parse(process.argv[1]).user)" "$ENV_JSON")
export PGPASSWORD=$("$NODE" -e "process.stdout.write(JSON.parse(process.argv[1]).password)" "$ENV_JSON")

log "──── backup run start ────"

FAILED=0

# ── 1. Databases: dump every ERP-owned DB the server knows ──
# tr -d '\r': Windows psql emits CRLF, and a \r inside a filename is fatal.
DBS=$("$PG_BIN_DIR/psql" -At -c "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1" 2>>"$LOG" | tr -d '\r' | grep -E "$BACKUP_DB_PATTERN" | grep -vE '_(shadow|scratch)$' || true)
if [ -z "$DBS" ]; then
  log "FATAL: no matching databases (is Postgres up? pattern: $BACKUP_DB_PATTERN)"
  exit 1
fi
SKIPPED=$(( $("$PG_BIN_DIR/psql" -At -c "SELECT count(*) FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'" 2>>"$LOG" | tr -d '\r') - $(echo "$DBS" | wc -l) ))
log "matching DBs: $(echo "$DBS" | wc -l)  (skipped $SKIPPED non-ERP/shadow/scratch)"

for DB in $DBS; do
  OUT="$BACKUP_DIR/db/$DB.dump"
  if "$PG_BIN_DIR/pg_dump" -Fc -d "$DB" -f "$OUT" 2>>"$LOG"; then
    # Integrity gate: a dump that can't be listed is not a backup.
    if "$PG_BIN_DIR/pg_restore" -l "$OUT" >/dev/null 2>&1; then
      log "OK   db  $DB  $(du -h "$OUT" | cut -f1)"
    else
      log "FAIL db  $DB  (pg_restore -l failed)"
      rm -f "$OUT"
      FAILED=1
    fi
  else
    log "FAIL db  $DB  (pg_dump exited non-zero)"
    rm -f "$OUT"
    FAILED=1
  fi
done

# ── 2. Uploaded files: photos, documents, logos ──
STAMP=$(date '+%Y-%m-%d')
# POSIX path for the archive target: GNU tar reads a leading "D:" as a
# remote-host spec ("Cannot connect to D: resolve failed").
if command -v cygpath >/dev/null 2>&1; then
  FILES_OUT_POSIX="$(cygpath -u "$BACKUP_DIR")/files/uploads-$STAMP.tar.gz"
else
  FILES_OUT_POSIX="$BACKUP_DIR/files/uploads-$STAMP.tar.gz"
fi
FILES_OUT="$BACKUP_DIR/files/uploads-$STAMP.tar.gz"
# Create AND verify with the POSIX form — tar treats "D:/..." as a remote-host
# spec on Windows, and a verification that can't open the file is worthless.
if tar -czf "$FILES_OUT_POSIX" -C "$ROOT" \
     apps/staff-service/data \
     apps/provision-service/data 2>>"$LOG"; then
  if tar -tzf "$FILES_OUT_POSIX" >/dev/null 2>>"$LOG"; then
    log "OK   files  uploads-$STAMP.tar.gz  $(du -h "$FILES_OUT" | cut -f1)"
  else
    log "FAIL files  archive unreadable"
    rm -f "$FILES_OUT"
    FAILED=1
  fi
else
  log "FAIL files  (tar exited non-zero)"
  rm -f "$FILES_OUT"
  FAILED=1
fi

# ── 3. Off-disk copy (optional): set BACKUP_COPY_TO to engage ──
if [ -n "${BACKUP_COPY_TO:-}" ]; then
  if command -v cygpath >/dev/null 2>&1; then
    DEST="$(cygpath -u "${BACKUP_COPY_TO%/}")"
  else
    DEST="${BACKUP_COPY_TO%/}"
  fi
  mkdir -p "$DEST/db" "$DEST/files"
  if cp -f "$BACKUP_DIR"/db/*.dump "$DEST/db/" 2>>"$LOG" && \
     cp -f "$BACKUP_DIR"/files/*.tar.gz "$DEST/files/" 2>>"$LOG"; then
    log "OK   copy   -> $BACKUP_COPY_TO"
  else
    log "FAIL copy   -> $BACKUP_COPY_TO"
    FAILED=1
  fi
fi

# ── 4. Retention: drop anything older than the window ──
PRUNED=$(find "$BACKUP_DIR" -type f -mtime +"$RETENTION_DAYS" -print -delete 2>>"$LOG" | wc -l)
log "retention  pruned $PRUNED file(s) older than $RETENTION_DAYS days"

SECS=$(( $(date +%s) - STARTED ))
log "──── run done in ${SECS}s  failed=$FAILED ────"

# ── 5. Observability hook (Phase 11.2): push the outcome so the BackupFailed
# alert fires on failure. Prometheus Pushgateway is optional — a missing
# gateway must never fail an otherwise-good backup run.
PUSHGATEWAY="${BACKUP_PUSHGATEWAY:-}"
if [ -n "$PUSHGATEWAY" ] && command -v curl >/dev/null 2>&1; then
  JOB="educore_backup"
  INSTANCE="$(hostname)"
  printf 'educore_backup_success %d\neducore_backup_duration_seconds %d\n' \
    "$((1 - FAILED))" "$SECS" \
  | curl -fsS --max-time 10 --data-binary @- \
      "${PUSHGATEWAY}/metrics/job/${JOB}/instance/${INSTANCE}" \
    >>"$LOG" 2>&1 \
    || log "WARN pushgateway unreachable — metric not pushed"
fi

exit $FAILED
