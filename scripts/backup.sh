#!/usr/bin/env bash
# ──────────────────────────────────────────────
# Nightly backup — Postgres + uploaded files.
#
# DUAL MODE — auto-detected, overridable with BACKUP_MODE=docker|host:
#
#   docker  (default when the app compose's postgres container is running)
#     • DB dumps: `pg_dump` INSIDE the postgres container, streamed to the
#       host via `docker compose exec -T`. Works on a fresh deploy: the
#       database has no published host port and needs none.
#     • Files: tarred from the named volumes THROUGH the running
#       staff-service / provision-service containers (their data dirs are
#       the volume mount points).
#   host  (the original Windows/dev deployment)
#     • pg_dump/psql from the host against DATABASE_URL; files tarred
#       straight from apps/*/data on disk.
#
# Shared behavior, both modes:
#   • Every non-template ERP database is dumped (custom format,
#     pg_restore-verified at creation time). New tenant DBs are covered
#     automatically — nothing is hardcoded to today's database list.
#   • Upload roots (photos, documents, logos) are archived as tarballs.
#   • 14-night retention, applied to everything in the backup dir.
#   • All progress goes to backups/backup.log; exit code is non-zero if
#     ANY dump or archive failed, so a scheduler can alert on it.
#   • Optional: BACKUP_COPY_TO second destination, BACKUP_PUSHGATEWAY
#     metrics push (Phase 11.2).
#
# Restore runbook: docs/BACKUPS.md (has a section per mode).
# ──────────────────────────────────────────────
set -u

# Anchor to the repo this script lives in — schedulers launch from anywhere.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "repo not found: $ROOT"; exit 1; }

BACKUP_DIR="$ROOT/backups"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
LOG="$BACKUP_DIR/backup.log"
STARTED=$(date +%s)
COMPOSE_FILE="docker/docker-compose.app.yml"

mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/files"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

if command -v node >/dev/null 2>&1; then NODE=node; else NODE="/c/Program Files/nodejs/node"; fi

# ── Shared .env reads (single node call; dotenv parses it identically to the
#    services, \n-joined PEMs and all) ──
ENV_JSON=$("$NODE" -e '
  const p = require("dotenv").config({ path: process.argv[1] }).parsed || {};
  const u = new URL(p.DATABASE_URL || "postgres://postgres@localhost:5432/school_erp");
  process.stdout.write(JSON.stringify({
    host: u.hostname, port: u.port || "5432", user: u.username,
    password: decodeURIComponent(u.password),
    pgUser: p.POSTGRES_USER || u.username || "postgres",
    dbPattern: p.BACKUP_DB_PATTERN || "",
    copyTo: p.BACKUP_COPY_TO || "",
    pushgateway: p.BACKUP_PUSHGATEWAY || ""
  }));
' "$ROOT/.env") || { log "FATAL: could not parse .env"; exit 1; }
envget() { "$NODE" -e "process.stdout.write(JSON.parse(process.argv[1]).$1)" "$ENV_JSON"; }

BACKUP_DB_PATTERN="${BACKUP_DB_PATTERN:-$(envget dbPattern)}"
BACKUP_DB_PATTERN="${BACKUP_DB_PATTERN:-^(school_erp|tenant_)}"
BACKUP_COPY_TO="${BACKUP_COPY_TO:-$(envget copyTo)}"
PUSHGATEWAY="${BACKUP_PUSHGATEWAY:-$(envget pushgateway)}"

# ── Mode detection ──
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }
if [ "${BACKUP_MODE:-}" = "docker" ] || { [ -z "${BACKUP_MODE:-}" ] && command -v docker >/dev/null 2>&1 && [ -n "$(dc ps -q postgres 2>/dev/null)" ]; }; then
  MODE=docker
else
  MODE=host
fi
FAILED=0

log "──── backup run start (${MODE} mode) ────"

if [ "$MODE" = "docker" ]; then
  # ──────────────────────────────────────────────
  # DOCKER MODE
  # ──────────────────────────────────────────────
  PGUSER=$(envget pgUser)

  # ── 1. Databases: enumerate + dump inside the postgres container ──
  DBS=$(dc exec -T postgres psql -U "$PGUSER" -At -c \
    "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1" \
    2>>"$LOG" | tr -d '\r' | grep -E "$BACKUP_DB_PATTERN" | grep -vE '_(shadow|scratch)$' || true)
  if [ -z "$DBS" ]; then
    log "FATAL: no matching databases (is the postgres container up? pattern: $BACKUP_DB_PATTERN)"
    exit 1
  fi
  log "matching DBs: $(echo "$DBS" | wc -l)"

  for DB in $DBS; do
    OUT="$BACKUP_DIR/db/$DB.dump"
    # Stream the dump to the host: the redirect runs HERE, so the artifact is
    # host-owned regardless of the container's user.
    if dc exec -T postgres pg_dump -U "$PGUSER" -Fc -d "$DB" > "$OUT" 2>>"$LOG"; then
      # Integrity gate: pg_restore -l INSIDE the container, reading the dump
      # back on stdin — a dump that can't be listed is not a backup.
      if dc exec -T postgres pg_restore -l /dev/stdin < "$OUT" >/dev/null 2>>"$LOG"; then
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

  # ── 2. Uploaded files: tar the volume data dirs through the running
  #       service containers. Paths INSIDE the archive are relative to the
  #       container mount (data/...), matching the restore commands in
  #       docs/BACKUPS.md. bookworm-slim ships tar; no extra image needed.
  STAMP=$(date '+%Y-%m-%d')
  file_backup() { # $1 service  $2 dir-under-workdir
    local SVC="$1" DIR="$2" OUT="$BACKUP_DIR/files/${SVC}-data-$STAMP.tar.gz"
    if dc exec -T "$SVC" tar -czf - -C "$DIR" . > "$OUT" 2>>"$LOG"; then
      if tar -tzf "$OUT" >/dev/null 2>>"$LOG"; then
        log "OK   files  ${SVC}  $(du -h "$OUT" | cut -f1)"
      else
        log "FAIL files  $SVC (archive unreadable)"
        rm -f "$OUT"
        FAILED=1
      fi
    else
      log "FAIL files  $SVC (tar exited non-zero)"
      rm -f "$OUT"
      FAILED=1
    fi
  }
  file_backup staff-service      /repo/apps/staff-service/data      # photos + documents
  file_backup provision-service  /repo/apps/provision-service/data  # logos

else
  # ──────────────────────────────────────────────
  # HOST MODE (original Windows/dev deployment)
  # ──────────────────────────────────────────────
  if command -v pg_dump >/dev/null 2>&1; then
    PG_BIN_DIR="$(dirname "$(command -v pg_dump)")"
  else
    PG_BIN_DIR="/c/Program Files/PostgreSQL/18/bin"
  fi

  export PGHOST=$(envget host)
  export PGPORT=$(envget port)
  export PGUSER=$(envget user)
  export PGPASSWORD=$(envget password)

  # tr -d '\r': Windows psql emits CRLF, and a \r inside a filename is fatal.
  DBS=$("$PG_BIN_DIR/psql" -At -c "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1" 2>>"$LOG" | tr -d '\r' | grep -E "$BACKUP_DB_PATTERN" | grep -vE '_(shadow|scratch)$' || true)
  if [ -z "$DBS" ]; then
    log "FATAL: no matching databases (is Postgres up? pattern: $BACKUP_DB_PATTERN)"
    exit 1
  fi
  DB_COUNT=$(echo "$DBS" | wc -l)
  TOTAL_DBS=$("$PG_BIN_DIR/psql" -At -c "SELECT count(*) FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'" 2>>"$LOG" | tr -d '\r')
  SKIPPED=$(( TOTAL_DBS - DB_COUNT ))
  log "matching DBs: $DB_COUNT  (skipped ${SKIPPED:-?} non-ERP/shadow/scratch)"

  for DB in $DBS; do
    OUT="$BACKUP_DIR/db/$DB.dump"
    if "$PG_BIN_DIR/pg_dump" -Fc -d "$DB" -f "$OUT" 2>>"$LOG"; then
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

  # ── Uploaded files from the on-disk roots (paths relative to repo root,
  #    matching the host-mode restore command in docs/BACKUPS.md) ──
  STAMP=$(date '+%Y-%m-%d')
  # POSIX path for the archive target: GNU tar reads a leading "D:" as a
  # remote-host spec ("Cannot connect to D: resolve failed").
  if command -v cygpath >/dev/null 2>&1; then
    FILES_OUT_POSIX="$(cygpath -u "$BACKUP_DIR")/files/uploads-$STAMP.tar.gz"
  else
    FILES_OUT_POSIX="$BACKUP_DIR/files/uploads-$STAMP.tar.gz"
  fi
  FILES_OUT="$BACKUP_DIR/files/uploads-$STAMP.tar.gz"
  # Create AND verify with the POSIX form — a verification that can't open
  # the file is worthless.
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
log "──── run done in ${SECS}s  mode=$MODE  failed=$FAILED ────"

# ── 5. Observability hook (Phase 11.2): push the outcome so the BackupFailed
# alert fires on failure. Prometheus Pushgateway is optional — a missing
# gateway must never fail an otherwise-good backup run.
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
