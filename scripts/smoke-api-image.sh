#!/usr/bin/env bash
# Start the built API image with its real CMD (including the OpenTelemetry
# preload) and require /healthz to answer. A container that crash-loops on a
# missing module (task #39: nested api/node_modules not copied) fails here.
# Usage: scripts/smoke-api-image.sh [image]   (default: cc-api)
set -euo pipefail

image="${1:-cc-api}"
name="cc-api-smoke-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

# Dummy values only: production mode demands these, nothing connects to ES at startup.
docker run -d --name "$name" \
  -e NODE_ENV=production \
  -e TOKEN_SIGNING_KEY="smoke-test-only-0123456789abcdef0123456789abcdef" \
  -e ES_URL=http://127.0.0.1:9 \
  -e ES_USERNAME=smoke \
  -e ES_PASSWORD=smoke \
  "$image" >/dev/null

for _ in $(seq 1 30); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
    echo "FAIL: container exited during startup" >&2
    docker logs "$name" >&2
    exit 1
  fi
  if docker exec "$name" wget -q -O - http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
    echo "OK: $image started and /healthz answered"
    docker logs "$name"
    exit 0
  fi
  sleep 1
done

echo "FAIL: /healthz did not answer within 30s" >&2
docker logs "$name" >&2
exit 1
