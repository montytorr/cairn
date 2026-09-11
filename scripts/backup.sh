#!/bin/bash
#
# Cairn backup. Configure with environment variables and run from cron.
#
#   CAIRN_BACKUP_DIR     where to write backups (default: /srv/backups/cairn)
#   CAIRN_DB_CONTAINER   Postgres container name (default: clawdius-postgres)
#   CAIRN_ATTACHMENT_DIR attachment tree (default: /srv/cairn/attachments)
#
# Backs up BOTH halves, because either alone is useless: a database dump
# without the storage tree loses every attachment, and the storage tree
# without the dump loses every reference to those files.
#
# Retention: 7 daily, 4 weekly (Sundays).
#
set -euo pipefail

DEST=${CAIRN_BACKUP_DIR:-/srv/backups/cairn}
DB_CONTAINER=${CAIRN_DB_CONTAINER:-clawdius-postgres}
DB_NAME=${CAIRN_DB_NAME:-cairn}
ATTACHMENTS=${CAIRN_ATTACHMENT_DIR:-/srv/cairn/attachments}

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DOW=$(date -u +%u)

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

mkdir -p "$DEST/daily" "$DEST/weekly" || fail "cannot create $DEST"

DUMP="$DEST/daily/cairn-db-$STAMP.dump"
TMP="$DUMP.tmp"
FILES="$DEST/daily/cairn-storage-$STAMP.tar.gz"
trap 'rm -f "$TMP"' EXIT

log "starting backup $STAMP"

# Public is the complete application database. Supabase-owned schemas, roles,
# owners and grants are deliberately excluded so the dump is stock-PG portable.
if ! docker exec "$DB_CONTAINER" pg_dump -U postgres -d "$DB_NAME" -Fc \
      --schema=public --no-owner --no-privileges > "$TMP"; then
  fail "pg_dump failed"
fi
mv "$TMP" "$DUMP"

SIZE=$(stat -c%s "$DUMP" 2>/dev/null || stat -f%z "$DUMP")
[ "$SIZE" -gt 1024 ] || fail "dump is implausibly small ($SIZE bytes)"
log "database dumped ($SIZE bytes)"

mkdir -p "$ATTACHMENTS"
if ! tar -czf "$FILES" -C "$ATTACHMENTS" .; then
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
