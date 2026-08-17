#!/usr/bin/env bash
set -Eeuo pipefail

for ((attempt = 1; attempt <= 120; attempt += 1)); do
  if curl --fail --silent http://127.0.0.1:4317/healthz >/dev/null; then
    exec /usr/sbin/nginx -g "daemon off;"
  fi
  sleep 0.25
done

echo "Node health endpoint did not become ready within 30 seconds." >&2
exit 1
