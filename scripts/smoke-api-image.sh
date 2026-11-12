#!/usr/bin/env bash
# Start the built API image with its real CMD (including the OpenTelemetry
# preload) against a throwaway pgvector Postgres and require /healthz to answer.
# A container that crash-loops on a missing module (task #39: nested api/node_modules
# not copied), a missing baked embedding model, or a schema migration failure fails here.
# The API shares the database container's network namespace so `localhost` works
# (non-local database hosts require TLS).
# Usage: scripts/smoke-api-image.sh [image]   (default: cc-api)
set -euo pipefail

image="${1:-cc-api}"
db="cc-api-smoke-db-$$"
name="cc-api-smoke-$$"
trap 'docker rm -f "$name" "$db" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$db" -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg17 >/dev/null
for _ in $(seq 1 30); do
  docker exec "$db" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

# Dummy secrets only: production mode demands them.
docker run -d --name "$name" --network "container:$db" \
  -e NODE_ENV=production \
  -e TOKEN_SIGNING_KEY="smoke-test-only-0123456789abcdef0123456789abcdef" \
  -e DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres" \
  "$image" >/dev/null

for _ in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
    echo "FAIL: container exited during startup" >&2
    docker logs "$name" >&2
    exit 1
  fi
  # The slim image has no wget/curl; use the node runtime that is already there.
  if docker exec "$name" node -e 'fetch("http://127.0.0.1:3000/healthz").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' >/dev/null 2>&1; then
    echo "OK: $image started, migrated the schema and /healthz answered"
    docker logs "$name"
    exit 0
  fi
  sleep 1
done

echo "FAIL: /healthz did not answer within 60s" >&2
docker logs "$name" >&2
exit 1
