#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: ops/ci/validate-deployment.sh [--check-only]

Validates the production Compose interpolation, shell scripts, Caddyfile, and
every Dockerfile runtime target. By default it also builds all Compose images.
Use --check-only to skip the final Compose images. The small custom Caddy
validation target and BATON web runtime image are always built so their
contracts are actually checked.
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
require_command openssl

minimum_compose_version=2.24.4
compose_version=$(docker compose version --short 2>/dev/null) || {
  printf 'deployment validation: Docker Compose is unavailable\n' >&2
  exit 1
}
compose_version=${compose_version#v}
if [[ ! "$compose_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
  printf 'deployment validation: could not parse Docker Compose version: %s\n' \
    "$compose_version" >&2
  exit 1
fi

compose_major=${BASH_REMATCH[1]}
compose_minor=${BASH_REMATCH[2]}
compose_patch=${BASH_REMATCH[3]}
IFS=. read -r minimum_compose_major minimum_compose_minor minimum_compose_patch \
  <<<"$minimum_compose_version"

if (( compose_major < minimum_compose_major \
  || (compose_major == minimum_compose_major && compose_minor < minimum_compose_minor) \
  || (compose_major == minimum_compose_major \
    && compose_minor == minimum_compose_minor \
    && compose_patch < minimum_compose_patch) )); then
  printf \
    'deployment validation: Docker Compose %s or later is required for !override/!reset (found %s)\n' \
    "$minimum_compose_version" "$compose_version" >&2
  exit 1
fi

printf 'Verifying local pilot secrets are excluded from the Docker build context...\n'
grep -Fxq 'ops/macos-pilot.env' .dockerignore || {
  printf 'deployment validation: ops/macos-pilot.env must be listed in .dockerignore\n' >&2
  exit 1
}
grep -Fxq 'ops/macos-pilot.credentials' .dockerignore || {
  printf 'deployment validation: ops/macos-pilot.credentials must be listed in .dockerignore\n' >&2
  exit 1
}

fixture_dir=$(mktemp -d)
baton_web_runtime_container=
cleanup() {
  if [[ -n "$baton_web_runtime_container" ]]; then
    docker rm -f "$baton_web_runtime_container" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$fixture_dir"
}
trap cleanup EXIT
umask 077

openssl req \
  -x509 \
  -newkey rsa:2048 \
  -nodes \
  -days 1 \
  -subj '/CN=turn.invalid' \
  -keyout "$fixture_dir/turn-key.pem" \
  -out "$fixture_dir/turn-cert.pem" \
  >/dev/null 2>&1

TURN_SHARED_SECRET=$(openssl rand -hex 32)
TURN_TLS_CERT_FILE="$fixture_dir/turn-cert.pem"
TURN_TLS_KEY_FILE="$fixture_dir/turn-key.pem"
ROUND_ACCESS_USER=round-ci
ROUND_ACCESS_PASSWORD_HASH='$2a$12$RJKd/exBEqUGjd.mtH9URu8H/TGJgwahZV8tA.xhPCM/4rdHfpmYS'
export TURN_SHARED_SECRET TURN_TLS_CERT_FILE TURN_TLS_KEY_FILE
export ROUND_ACCESS_USER ROUND_ACCESS_PASSWORD_HASH

printf 'Validating Compose interpolation with temporary dummy fixtures...\n'
docker compose --env-file ops/production.env.example config --quiet

printf 'Validating the macOS pilot Compose override...\n'
macos_pilot_config=$(
  ACME_EMAIL=ci@round.invalid \
  TURN_EXTERNAL_IP=203.0.113.10 \
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
  and (.services.turn.network_mode == null)
  and (.services.turn.networks.turn.ipv4_address == "172.31.0.10")
  and (.networks.turn.ipam.config[0].subnet == "172.31.0.0/24")
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
  and ([.services.turn.ports[]
        | select(.target == 3478 and .protocol == "tcp")]
      | length == 1)
  and ([.services.turn.ports[]
        | select(.target == 3478 and .protocol == "udp")]
      | length == 1)
  and ([.services.turn.ports[]
        | select(.target == 5349 and .protocol == "tcp")]
      | length == 1)
  and ([.services.turn.ports[]
        | select(.target == 5349 and .protocol == "udp")]
      | length == 1)
  and ([.services.turn.ports[]
        | select(.target >= 49160 and .target <= 49259 and .protocol == "udp")]
      | length == 100)
' <<<"$macos_pilot_config" >/dev/null

printf 'Validating deployment shell scripts...\n'
sh -n ops/turn/entrypoint.sh
bash -n ops/turn/probe.sh
bash -n ops/turn/resolve-external-pilot-target.sh
bash -n ops/turn/resolve-external-release.sh
bash -n ops/turn/test-external-pilot-target.sh
bash -n ops/turn/test-external-release.sh
bash -n ops/turn/test-probe.sh
bash -n ops/turn/verify-tls.sh
bash -n ops/turn/test-tls-verification.sh
bash -n ops/linux/common.sh
bash -n ops/linux/preflight.sh
bash -n ops/linux/deploy.sh
bash -n ops/linux/rollback.sh
bash -n ops/linux/reload-turn-certificate.sh
bash -n ops/linux/backup-caddy.sh
bash -n ops/linux/restore-caddy.sh
bash -n ops/linux/test-linux-ops.sh
bash -n ops/linux/test-systemd-units.sh
bash -n ops/ci/run-baton-edge-e2e.sh
bash -n ops/ci/verify-baton-web-runtime.sh
bash -n ops/linux/certbot/round-turn-deploy-hook
bash -n ops/linux/certbot/round-turn-certificate-check
bash -n ops/linux/certbot/round-turn-certificate-reconcile
bash ops/turn/probe.sh --help >/dev/null
bash ops/turn/test-external-pilot-target.sh
bash ops/turn/test-external-release.sh
bash ops/turn/test-probe.sh
bash ops/turn/test-tls-verification.sh
bash ops/linux/test-linux-ops.sh
bash ops/linux/test-systemd-units.sh

printf 'Validating the external TURN workflow contract...\n'
node ops/ci/validate-external-turn-workflow.mjs
node ops/ci/test-validate-external-turn-workflow.mjs
node ops/ci/validate-external-turn-monitor.mjs
node ops/ci/test-validate-external-turn-monitor.mjs

printf 'Validating the signed release workflow contract...\n'
node ops/ci/validate-release-workflow.mjs

caddy_validation_image=round-caddy-validation:local
printf 'Building the pinned custom Caddy runtime...\n'
docker build \
  --target caddy-runtime \
  --tag "$caddy_validation_image" \
  .

printf 'Verifying the rate-limit module and Caddy configuration...\n'
docker run --rm "$caddy_validation_image" caddy list-modules --skip-standard \
  | grep -Fx 'http.handlers.rate_limit' >/dev/null
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
docker run --rm \
  -v "$repo_root/ops/caddy/BatonWebCaddyfile:/etc/caddy/BatonWebCaddyfile:ro" \
  "$caddy_validation_image" \
  caddy validate --config /etc/caddy/BatonWebCaddyfile --adapter caddyfile

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
      [.. | objects
        | select((.handle? // []) | any(.handler? == "authentication"))
        | .match[0].not[0].path] == [[
          "/healthz",
          "/signal",
          "/api/turn-credentials"
        ]]
    ' >/dev/null

printf 'Verifying the BATON browser cache and entry-route boundary...\n'
docker run --rm \
  -v "$repo_root/ops/caddy/BatonWebCaddyfile:/etc/caddy/BatonWebCaddyfile:ro" \
  "$caddy_validation_image" \
  caddy adapt --config /etc/caddy/BatonWebCaddyfile --adapter caddyfile \
  | jq -e '
      def route($path):
        .apps.http.servers.srv0.routes[]
        | select(.match[0].path? == [$path]);
      (route("/round-ui/assets/*")) as $assets
      | (route("/round-ui/favicon.svg")) as $favicon
      | (route("/round-ui/*")) as $asset_root
      | (route("/room/*")) as $room
      | ([$assets | .. | objects
          | select(.handler? == "headers")
          | .response.set["Cache-Control"][0]]) as $asset_cache_controls
      | ([$assets | .. | objects
          | select(
              has("file")
              and .path_regexp?.name == "vite_asset"
            )
          | .path_regexp.pattern][0]
          == "^/assets/(?:[^/]+/)*[^/]+-[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9.]+$")
        and ($asset_cache_controls | length == 2)
        and ($asset_cache_controls
          | contains([
              "public, max-age=31536000, immutable",
              "no-store"
            ]))
        and ([$assets | .. | objects
          | select(.handler? == "rewrite")
          | .strip_path_prefix][0] == "/round-ui")
        and ([$assets | .. | objects
          | select(.handler? == "static_response")
          | .status_code][0] == 404)
        and ([$favicon | .. | objects
          | select(.handler? == "headers")
          | .response.set["Cache-Control"][0]][0] == "no-cache")
        and ([$asset_root | .. | objects
          | select(.handler? == "headers")
          | .response.set["Cache-Control"][0]][0] == "no-store")
        and ([$asset_root | .. | objects
          | select(.handler? == "static_response")
          | .status_code][0] == 404)
        and ([$room | .. | objects
          | select(.handler? == "headers")
          | .response.set["Cache-Control"][0]][0] == "no-store")
        and ([$room | .. | objects
          | select(has("try_files"))
          | .try_files][0] == ["{http.request.uri.path}", "/index.html"])
    ' >/dev/null

printf 'Checking Dockerfile runtime targets...\n'
for target in web-runtime baton-web-runtime signaling-runtime turn-runtime; do
  docker build --check --target "$target" .
done

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
docker compose --env-file ops/production.env.example build --pull
printf 'Deployment validation passed.\n'
