#!/bin/bash
# Restore the newest portable dump into a throwaway database and verify both
# database state and the independent attachment archive.
set -euo pipefail

DEST=${CAIRN_BACKUP_DIR:-/srv/backups/cairn}
DB_CONTAINER=${CAIRN_DB_CONTAINER:-clawdius-postgres}
SCRATCH="cairn_restore_drill_$(date -u +%s)"

LATEST=$(find "$DEST/daily" -maxdepth 1 -name 'cairn-db-*.dump' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
[ -n "$LATEST" ] || { echo "no dump to restore"; exit 1; }
echo "restoring $(basename "$LATEST")"

q() { docker exec "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d "$1" -qtAX -c "$2"; }
q postgres "create database $SCRATCH owner cairn_app" >/dev/null
trap 'q postgres "drop database if exists $SCRATCH with (force)" >/dev/null' EXIT
q "$SCRATCH" 'drop schema public' >/dev/null

docker exec -i "$DB_CONTAINER" pg_restore -U cairn_app -d "$SCRATCH" \
  --exit-on-error --no-owner --no-privileges < "$LATEST"

check() {
  local label="$1" sql="$2" got
  got=$(q "$SCRATCH" "$sql")
  echo "  $label: $got"
  [ "$got" != "0" ] && [ "$got" != "f" ] || { echo "DRILL FAILED on $label"; exit 1; }
}

check "tasks" "select count(*) from public.tasks"
check "projects" "select count(*) from public.projects"
check "resolutions" "select count(*) from public.tasks where resolution is not null"
check "app users" "select count(*) from public.app_users"
check "search vectors" "select count(*) from public.tasks where search_vector is not null"

LATEST_FILES=$(find "$DEST/daily" -maxdepth 1 -name 'cairn-storage-*.tar.gz' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
[ -n "$LATEST_FILES" ] && tar -tzf "$LATEST_FILES" >/dev/null
echo "  attachment archive: readable"
echo "DRILL PASSED"
