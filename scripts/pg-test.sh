#!/usr/bin/env bash
# Dockerized Postgres contract test (M12). Spins a throwaway Postgres, runs the
# real-connection integration suite against it, and tears it down.
#
#   npm run test:pg        # requires Docker
set -uo pipefail

NAME=counterindex-pg-test
PORT=55432
docker rm -f "$NAME" >/dev/null 2>&1 || true

echo "starting postgres container…"
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=counterindex \
  -p "${PORT}:5432" postgres:16-alpine >/dev/null

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "waiting for readiness…"
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "${ready:-0}" != "1" ]; then echo "postgres did not become ready"; exit 1; fi

export PG_URL="postgres://postgres:pw@localhost:${PORT}/counterindex"
echo "running integration suite against $PG_URL"
npx vitest run tests/postgres.integration.test.ts
code=$?

exit $code
