#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
사용법: ops/ci/validate-deployment.sh [--check-only]

프로덕션 Compose 보간과 빌드 target, shell script, Caddyfile, Dockerfile 전체를 검증합니다.
기본 실행은 Compose image 전체도 build합니다. --check-only를 사용하면 마지막 Compose image
build만 건너뜁니다. 작은 custom Caddy 검증 target과 BATON web runtime image는 실행 계약을
확인하기 위해 항상 build합니다.
EOF
}

check_only=false
case "${1:-}" in
  '')
    ;;
  --check-only)
    check_only=true
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if (( $# > 1 )); then
  usage >&2
  exit 2
fi

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'deployment validation: missing required command: %s\n' "$1" >&2
    exit 1
  }
}

require_command docker
require_command jq
require_command node

printf 'Verifying local pilot secrets are excluded from the Docker build context...\n'
grep -Fxq 'ops/macos-pilot.env' .dockerignore || {
  printf 'deployment validation: ops/macos-pilot.env must be listed in .dockerignore\n' >&2
  exit 1
}
grep -Fxq 'ops/restic-r2.env' .dockerignore || {
  printf 'deployment validation: ops/restic-r2.env must be listed in .dockerignore\n' >&2
  exit 1
}
grep -Fxq 'ops/macos-pilot.credentials' .dockerignore || {
  printf 'deployment validation: ops/macos-pilot.credentials must be listed in .dockerignore\n' >&2
  exit 1
}

fixture_dir=$(mktemp -d)
baton_web_runtime_container=
caddy_log_container=
cleanup() {
  if [[ -n "$baton_web_runtime_container" ]]; then
    docker rm -f "$baton_web_runtime_container" >/dev/null 2>&1 || true
  fi
  if [[ -n "$caddy_log_container" ]]; then
    docker rm -f "$caddy_log_container" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$fixture_dir"
}
trap cleanup EXIT
umask 077

TURN_CLOUDFLARE_KEY_ID=ci-key
TURN_CLOUDFLARE_API_TOKEN=ci-token
GRAFANA_CLOUD_PROMETHEUS_URL=https://prometheus.example.invalid/api/prom/push
GRAFANA_CLOUD_PROMETHEUS_USER=12345
GRAFANA_CLOUD_API_TOKEN=ci-token
ROUND_ACCESS_USER=round-ci
ROUND_ACCESS_PASSWORD_HASH='$2a$12$RJKd/exBEqUGjd.mtH9URu8H/TGJgwahZV8tA.xhPCM/4rdHfpmYS'
export TURN_CLOUDFLARE_KEY_ID TURN_CLOUDFLARE_API_TOKEN
export GRAFANA_CLOUD_PROMETHEUS_URL GRAFANA_CLOUD_PROMETHEUS_USER
export GRAFANA_CLOUD_API_TOKEN
export ROUND_ACCESS_USER ROUND_ACCESS_PASSWORD_HASH

printf 'Validating Compose interpolation with temporary dummy fixtures...\n'
production_config=$(docker compose --env-file ops/production.env.example config --format json)
jq -e '
  ((.services.signaling.networks | keys | sort) == ["backend", "egress"])
  and ((.services.edge.networks | keys | sort) == ["backend", "edge"])
  and (.services.edge.restart == "always")
  and (.networks.backend.internal == true)
  and ((.networks.egress.internal // false) == false)
' <<<"$production_config" >/dev/null
observability_config=$(
  COMPOSE_PROFILES=observability \
    docker compose --env-file ops/production.env.example config --format json
)
jq -e '
  ((.services | keys) == ["alloy", "edge", "signaling"])
  and ((.services.alloy.networks | keys | sort) == ["backend", "egress"])
  and ((.services.alloy.ports // []) == [])
  and (.services.alloy.image
    == "grafana/alloy:v1.18.1@sha256:0f4434c92b3e6cdac38bb129b344e1790c246f7b6e2eaffcc16a5fa363240e33")
  and (.configs.alloy_config.content | contains("/actuator/prometheus"))
  and (.configs.alloy_config.content | contains("prometheus.remote_write"))
' <<<"$observability_config" >/dev/null
alloy_config_file="$fixture_dir/config.alloy"
jq -er '.configs.alloy_config.content' <<<"$observability_config" >"$alloy_config_file"
printf 'Validating the Grafana Alloy configuration...\n'
docker run --rm \
  -e GRAFANA_CLOUD_PROMETHEUS_URL \
  -e GRAFANA_CLOUD_PROMETHEUS_USER \
  -e GRAFANA_CLOUD_API_TOKEN \
  -v "$alloy_config_file:/etc/alloy/config.alloy:ro" \
  "$(jq -er '.services.alloy.image' <<<"$observability_config")" \
  validate /etc/alloy/config.alloy

printf 'Validating the macOS pilot Compose override...\n'
macos_pilot_config=$(
  ACME_EMAIL=ci@round.invalid \
    docker compose \
      -f compose.yml \
      -f compose.macos-pilot.yml \
      --env-file ops/macos-pilot.env.example \
      config --format json
)
jq -e '
  ([.services.edge.ports[]
      | {target, published, protocol}]
    | contains([
        {target: 80, published: "8080", protocol: "tcp"},
        {target: 443, published: "8443", protocol: "tcp"},
        {target: 443, published: "8443", protocol: "udp"}
      ]))
  and ((.services | keys) == ["edge", "signaling"])
  and (.services.edge.command == [
        "caddy",
        "run",
        "--config",
        "/etc/caddy/Caddyfile.macos-pilot",
        "--adapter",
        "caddyfile"
      ])
  and ([.services.edge.volumes[]
        | select(
            .type == "bind"
            and .target == "/etc/caddy/Caddyfile.macos-pilot"
            and .read_only == true
          )]
      | length == 1)
' <<<"$macos_pilot_config" >/dev/null

printf 'Validating deployment shell scripts...\n'
bash -n ops/ci/run-baton-edge-e2e.sh
bash -n ops/ci/promote-image-tags.sh
bash -n ops/ci/test-promote-image-tags.sh
bash -n ops/linux/test-systemd-units.sh
bash ops/ci/test-promote-image-tags.sh
bash ops/linux/test-linux-ops.sh
bash ops/linux/test-systemd-units.sh

printf 'Validating the signed release workflow contract...\n'
node ops/ci/validate-release-workflow.mjs

printf 'Validating the BrowserStack workflow contract...\n'
node ops/ci/validate-browserstack-workflow.mjs

caddy_validation_image=round-caddy-validation:local
printf 'Building the pinned custom Caddy runtime...\n'
docker build \
  --target caddy-runtime \
  --tag "$caddy_validation_image" \
  .

printf 'Verifying the Caddy configuration...\n'
docker run --rm \
  -e ACME_EMAIL=ci@round.invalid \
  -e ROUND_ACCESS_PASSWORD_HASH \
  -e ROUND_ACCESS_USER \
  -e ROUND_DOMAIN=round.invalid \
  "$caddy_validation_image" \
  caddy validate --config /etc/caddy/Caddyfile
docker run --rm \
  -v "$repo_root/ops/caddy/Caddyfile.macos-pilot:/etc/caddy/Caddyfile.macos-pilot:ro" \
  -e ACME_EMAIL=ci@round.invalid \
  -e ROUND_ACCESS_PASSWORD_HASH \
  -e ROUND_ACCESS_USER \
  -e ROUND_DOMAIN=round.invalid \
  "$caddy_validation_image" \
  caddy validate --config /etc/caddy/Caddyfile.macos-pilot
printf 'Verifying the adapted rate-limit policy and handler order...\n'
docker run --rm \
  -e ACME_EMAIL=ci@round.invalid \
  -e ROUND_ACCESS_PASSWORD_HASH \
  -e ROUND_ACCESS_USER \
  -e ROUND_DOMAIN=round.invalid \
  "$caddy_validation_image" \
  caddy adapt --config /etc/caddy/Caddyfile \
  | jq -e '
      ([.. | objects]) as $objects
      | ([$objects[] | select(has("handler")) | .handler]) as $handlers
      | ([$objects[] | select(.handler? == "rate_limit")][0]) as $rate
      | ($handlers | index("rate_limit")) as $rate_index
      | ($handlers | index("authentication")) as $auth_index
      | ($rate_index != null)
        and ($auth_index != null)
        and ($rate_index < $auth_index)
        and ($rate.sweep_interval == 60000000000)
        and ($rate.rate_limits.pilot_client.key == "{http.request.remote.host}")
        and ($rate.rate_limits.pilot_client.max_events == 96)
        and ($rate.rate_limits.pilot_client.window == 300000000000)
        and ($rate.rate_limits.pilot_client.ipv6_prefix == 64)
        and ($rate.rate_limits.pilot_client.match[0].not[0].path == ["/healthz"])
        and ($rate.rate_limits.pilot_client.match[0].header.Authorization == ["*"])
        and (($rate.rate_limits | keys) == ["pilot_client"])
        and (.logging.logs.default.encoder.fields["request>remote_ip"].filter == "hash")
        and (.logging.logs.default.encoder.fields["request>client_ip"].filter == "hash")
        and ((.logging.logs.default.encoder.fields | has("remote_ip")) | not)
    ' >/dev/null

printf 'Verifying the macOS pilot mobile transport exception...\n'
docker run --rm \
  -v "$repo_root/ops/caddy/Caddyfile.macos-pilot:/etc/caddy/Caddyfile.macos-pilot:ro" \
  -e ACME_EMAIL=ci@round.invalid \
  -e ROUND_ACCESS_PASSWORD_HASH \
  -e ROUND_ACCESS_USER \
  -e ROUND_DOMAIN=round.invalid \
  "$caddy_validation_image" \
  caddy adapt --config /etc/caddy/Caddyfile.macos-pilot \
  | jq -e '
      (.logging.logs.default.encoder.fields["request>remote_ip"].filter == "hash")
      and (.logging.logs.default.encoder.fields["request>client_ip"].filter == "hash")
      and ((.logging.logs.default.encoder.fields | has("remote_ip")) | not)
      and ([.. | objects
        | select((.handle? // []) | any(.handler? == "authentication"))
        | .match[0].not[0].path] == [[
          "/healthz",
          "/signal",
          "/api/turn-credentials"
        ]])
    ' >/dev/null

printf 'Verifying that Caddy access logs do not expose client addresses...\n'
caddy_log_container=$(
  docker run --detach \
    --publish 127.0.0.1::8081 \
    -e ACME_EMAIL=ci@round.invalid \
    -e ROUND_ACCESS_PASSWORD_HASH \
    -e ROUND_ACCESS_USER \
    -e ROUND_DOMAIN=http://127.0.0.1:8081 \
    "$caddy_validation_image"
)
caddy_log_port=$(
  docker inspect \
    --format '{{(index (index .NetworkSettings.Ports "8081/tcp") 0).HostPort}}' \
    "$caddy_log_container"
)
caddy_log_ready=false
for _ in {1..30}; do
  if curl \
    --silent \
    --output /dev/null \
    --connect-timeout 1 \
    --max-time 2 \
    "http://127.0.0.1:$caddy_log_port/healthz"; then
    caddy_log_ready=true
    break
  fi
  sleep 1
done
"$caddy_log_ready" || {
  printf 'deployment validation: Caddy access log fixture did not start\n' >&2
  exit 1
}
docker logs "$caddy_log_container" 2>&1 \
  | jq -s -e '
      [.[] | select(.request?)]
      | last
      | (.request.remote_ip | test("^[0-9a-f]{8,64}$"))
        and (.request.client_ip | test("^[0-9a-f]{8,64}$"))
        and ((.request | has("headers")) | not)
        and ((.request | has("uri")) | not)
    ' >/dev/null
docker rm -f "$caddy_log_container" >/dev/null
caddy_log_container=

printf 'Checking the entire Dockerfile...\n'
docker build --check .

printf 'Checking the production Compose build targets...\n'
production_build_targets=$(
  jq -er '
    .services[]
    | select(.build != null)
    | .build.target
    | if type == "string" and length > 0
      then .
      else error("production Compose build target is missing")
      end
  ' <<<"$production_config"
)
while IFS= read -r target; do
  docker build --check --target "$target" .
done <<<"$production_build_targets"

baton_web_image=round-baton-web-validation:local
printf 'Building the BATON browser runtime image...\n'
docker build \
  --target baton-web-runtime \
  --tag "$baton_web_image" \
  .
test "$(docker image inspect --format '{{ index .Config.Labels "io.round.auth-mode" }}' "$baton_web_image")" = baton

printf 'Verifying the BATON browser runtime over HTTP...\n'
baton_web_runtime_container=$(
  docker run --detach --publish 127.0.0.1::8080 "$baton_web_image"
)
baton_web_runtime_port=$(
  docker inspect \
    --format '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}' \
    "$baton_web_runtime_container"
)
baton_web_runtime_origin="http://127.0.0.1:$baton_web_runtime_port"
curl \
  --fail \
  --silent \
  --show-error \
  --retry 30 \
  --retry-all-errors \
  --retry-delay 1 \
  --connect-timeout 1 \
  --max-time 2 \
  "$baton_web_runtime_origin/healthz" \
  >/dev/null
bash ops/ci/verify-baton-web-runtime.sh "$baton_web_runtime_origin"
docker rm -f "$baton_web_runtime_container" >/dev/null
baton_web_runtime_container=

if "$check_only"; then
  printf 'Deployment checks passed; image builds skipped by --check-only.\n'
  exit 0
fi

printf 'Building all production Compose images...\n'
ROUND_EDGE_IMAGE=round-edge-validation:local \
ROUND_SIGNALING_IMAGE=round-signaling-validation:local \
  docker compose --env-file ops/production.env.example build --pull
printf 'Deployment validation passed.\n'
