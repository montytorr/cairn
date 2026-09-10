#!/bin/bash
#
# Cairn backup. Configure with environment variables and run from cron.
#
#   CAIRN_STACK_DIR   directory holding the Supabase stack's .env  (required)
#   CAIRN_BACKUP_DIR  where to write backups                       (required)
#   CAIRN_DB_CONTAINER  Postgres container name        (default: supabase-db)
#
# Backs up BOTH halves, because either alone is useless: a database dump
# without the storage tree loses every attachment, and the storage tree
# without the dump loses every reference to those files.
#
# Retention: 7 daily, 4 weekly (Sundays).
#
set -uo pipefail

STACK=${CAIRN_STACK_DIR:?set CAIRN_STACK_DIR to the Supabase stack directory}
DEST=${CAIRN_BACKUP_DIR:?set CAIRN_BACKUP_DIR to a backup destination}
DB_CONTAINER=${CAIRN_DB_CONTAINER:-supabase-db}

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DOW=$(date -u +%u)

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

mkdir -p "$DEST/daily" "$DEST/weekly" || fail "cannot create $DEST"
cd "$STACK" || fail "no stack at $STACK"

PW=$(grep -m1 '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
DB=$(grep -m1 '^POSTGRES_DB=' .env | cut -d= -f2-)
[ -n "$PW" ] && [ -n "$DB" ] || fail "could not read credentials from $STACK/.env"

DUMP="$DEST/daily/cairn-db-$STAMP.dump"
FILES="$DEST/daily/cairn-storage-$STAMP.tar.gz"

log "starting backup $STAMP"

# Custom format so pg_restore can be selective; --clean so restoring into a
# populated scratch database is repeatable.
if ! docker exec -e PGPASSWORD="$PW" "$DB_CONTAINER" \
      pg_dump -U postgres -d "$DB" -Fc --clean --if-exists > "$DUMP"; then
  rm -f "$DUMP"
  fail "pg_dump failed"
fi

SIZE=$(stat -c%s "$DUMP" 2>/dev/null || stat -f%z "$DUMP")
[ "$SIZE" -gt 1024 ] || fail "dump is implausibly small ($SIZE bytes)"
log "database dumped ($SIZE bytes)"

if ! tar -czf "$FILES" -C "$STACK/volumes" storage; then
  rm -f "$FILES"
  fail "storage archive failed"
fi
log "storage archived"

# Checksums, so silent corruption is detectable later.
(cd "$DEST/daily" && sha256sum "$(basename "$DUMP")" "$(basename "$FILES")" >> SHA256SUMS)

[ "$DOW" = "7" ] && cp -p "$DUMP" "$FILES" "$DEST/weekly/" && log "promoted to weekly"

find "$DEST/daily"  -name 'cairn-db-*.dump'        -mtime +7  -delete
find "$DEST/daily"  -name 'cairn-storage-*.tar.gz' -mtime +7  -delete
find "$DEST/weekly" -name 'cairn-*'                -mtime +28 -delete

log "backup $STAMP complete"
