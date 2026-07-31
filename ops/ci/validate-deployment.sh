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
require_command openssl
docker compose version >/dev/null

fixture_dir=$(mktemp -d)
baton_web_container=
cleanup() {
  if [[ -n "$baton_web_container" ]]; then
    docker rm -f "$baton_web_container" >/dev/null 2>&1 || true
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

printf 'Validating deployment shell scripts...\n'
sh -n ops/turn/entrypoint.sh
bash -n ops/turn/probe.sh
bash -n ops/turn/verify-tls.sh
bash -n ops/turn/test-tls-verification.sh
bash ops/turn/probe.sh --help >/dev/null
bash ops/turn/test-tls-verification.sh

tls_gate_line=$(
  grep -nF '    verify_tls_endpoint' ops/turn/probe.sh \
    | head -n 1 \
    | cut -d: -f1
)
tls_client_line=$(
  grep -nF 'exec /usr/bin/turnutils_uclient' ops/turn/probe.sh \
    | tail -n 1 \
    | cut -d: -f1
)
[[ -n "$tls_gate_line" && -n "$tls_client_line" ]]
(( tls_gate_line < tls_client_line ))
grep -Fq -- '-servername "$host"' ops/turn/verify-tls.sh
grep -Fq -- '-verify_hostname "$host"' ops/turn/verify-tls.sh
grep -Fq -- '-verify_return_error' ops/turn/verify-tls.sh

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
baton_web_container=$(docker create "$baton_web_image")
docker cp "$baton_web_container:/srv" "$fixture_dir/baton-web"
docker rm "$baton_web_container" >/dev/null
baton_web_container=
test "$(cat "$fixture_dir/baton-web/.round-auth-mode")" = baton
test -f "$fixture_dir/baton-web/index.html"
test -d "$fixture_dir/baton-web/assets"
grep -Fq '/round-ui/assets/' "$fixture_dir/baton-web/index.html"
grep -R -Fq '/api/v1/auth/session' "$fixture_dir/baton-web/assets"
grep -R -Fq 'round/rooms' "$fixture_dir/baton-web/assets"

if "$check_only"; then
  printf 'Deployment checks passed; image builds skipped by --check-only.\n'
  exit 0
fi

printf 'Building all production Compose images...\n'
docker compose --env-file ops/production.env.example build --pull
printf 'Deployment validation passed.\n'
