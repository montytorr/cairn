#!/usr/bin/env bash
#
# Runs a command against a throwaway PostgreSQL: a postgres:16 container on a
# free loopback port Docker picks, its data on tmpfs, removed on exit whether
# the command passed, failed or was interrupted. DATABASE_URL points at it.
#
#   bash scripts/with-throwaway-postgres.sh 'npm run db:migrate && npm run test:integration'
#
# This is how the integration suite runs before a merge (`npm run
# test:integration:local`, a `.drove.json` check): it left GitHub CI, which
# keeps only the unit suite, the build and the image the deploy needs.
#
#   PG_IMAGE   image to start (default: postgres:16, what production runs)
set -euo pipefail

[ $# -gt 0 ] || { echo "usage: $0 '<command>'" >&2; exit 2; }

image=${PG_IMAGE:-postgres:16}
user=cairn
db=cairn_test
name="cairn-pg-$$-${RANDOM}"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT TERM

docker run -d --name "$name" \
  -e POSTGRES_USER="$user" -e POSTGRES_DB="$db" -e POSTGRES_HOST_AUTH_METHOD=trust \
  --tmpfs /var/lib/postgresql/data:rw \
  -p 127.0.0.1::5432 "$image" >/dev/null

port=$(docker port "$name" 5432/tcp | head -n 1 | sed 's/.*://')

# The entrypoint's init server listens on the socket only, so a TCP check
# passes once the real server is up, not during initdb.
ready=0
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -q -h 127.0.0.1 -U "$user" -d "$db"; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "postgres did not become ready" >&2; docker logs "$name" >&2; exit 1; }

export DATABASE_URL="postgresql://${user}@127.0.0.1:${port}/${db}"
echo "throwaway postgres ($image) on 127.0.0.1:${port}"
bash -c "$*"
