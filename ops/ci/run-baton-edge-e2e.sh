#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

baton_edge_image=${ROUND_BATON_E2E_IMAGE:-round-baton-web-e2e:local}
baton_edge_container=
cleanup() {
  if [[ -n "$baton_edge_container" ]]; then
    docker rm -f "$baton_edge_container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker build --target baton-web-runtime --tag "$baton_edge_image" .
baton_edge_container=$(
  docker run --detach --publish 127.0.0.1::8080 "$baton_edge_image"
)
baton_edge_port=$(
  docker inspect \
    --format '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}' \
    "$baton_edge_container"
)
baton_edge_origin="http://127.0.0.1:$baton_edge_port"

curl \
  --fail \
  --silent \
  --show-error \
  --retry 30 \
  --retry-all-errors \
  --retry-delay 1 \
  --connect-timeout 1 \
  --max-time 2 \
  "$baton_edge_origin/healthz" \
  >/dev/null

bash ops/ci/verify-baton-web-runtime.sh "$baton_edge_origin"

ROUND_BATON_E2E_BASE_URL="$baton_edge_origin" \
ROUND_BATON_E2E_EDGE=true \
  npx playwright test --config playwright.baton.config.ts
