#!/bin/bash
#
# Restore drill. An untested backup is not a backup.
#
# Restores the newest dump into a throwaway database inside the running
# Postgres, asserts the data is really there, then drops it. Touches nothing
# the live application uses.
#
#   CAIRN_STACK_DIR / CAIRN_BACKUP_DIR / CAIRN_DB_CONTAINER  as in backup.sh
#
set -uo pipefail

STACK=${CAIRN_STACK_DIR:?set CAIRN_STACK_DIR}
DEST=${CAIRN_BACKUP_DIR:?set CAIRN_BACKUP_DIR}
DB_CONTAINER=${CAIRN_DB_CONTAINER:-supabase-db}
SCRATCH=cairn_restore_drill

cd "$STACK" || { echo "no stack at $STACK"; exit 1; }
PW=$(grep -m1 '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)

LATEST=$(ls -1t "$DEST"/daily/cairn-db-*.dump 2>/dev/null | head -1)
[ -n "$LATEST" ] || { echo "no dump to restore"; exit 1; }
echo "restoring $(basename "$LATEST")"

q() { docker exec -e PGPASSWORD="$PW" "$DB_CONTAINER" psql -U postgres -d "$1" -qtAX -c "$2"; }

q postgres "drop database if exists $SCRATCH" >/dev/null
q postgres "create database $SCRATCH" >/dev/null

# The dump references roles the scratch database lacks; --no-owner and
# --no-privileges stop those becoming hard failures.
docker exec -i -e PGPASSWORD="$PW" "$DB_CONTAINER" \
  pg_restore -U postgres -d "$SCRATCH" --no-owner --no-privileges < "$LATEST" 2>/dev/null

FAILED=0
check() {
  if [ "${2:-0}" -gt 0 ] 2>/dev/null; then echo "  PASS $1 ($2)"
  else echo "  FAIL $1 (got '${2:-}')"; FAILED=1; fi
}

check "tasks restored"        "$(q $SCRATCH 'select count(*) from public.tasks')"
check "projects restored"     "$(q $SCRATCH 'select count(*) from public.projects')"
check "resolutions preserved" "$(q $SCRATCH 'select count(*) from public.tasks where resolution is not null')"
check "rls policies restored" "$(q $SCRATCH "select count(*) from pg_policies where schemaname='public'")"
# The generated column must survive, or prior-work discovery comes back
# silently broken while everything else looks fine.
check "search vector works"   "$(q $SCRATCH "select count(*) from public.tasks where search_vector @@ websearch_to_tsquery('english','the')")"

LATEST_FILES=$(ls -1t "$DEST"/daily/cairn-storage-*.tar.gz 2>/dev/null | head -1)
if [ -n "$LATEST_FILES" ] && tar -tzf "$LATEST_FILES" >/dev/null 2>&1; then
  echo "  PASS storage archive readable"
else
  echo "  FAIL storage archive missing or corrupt"; FAILED=1
fi

q postgres "drop database $SCRATCH" >/dev/null
[ "$FAILED" = "0" ] && echo "DRILL PASSED" || { echo "DRILL FAILED"; exit 1; }
