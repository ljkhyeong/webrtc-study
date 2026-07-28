#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: ops/ci/validate-deployment.sh [--check-only]

Validates the production Compose interpolation, shell scripts, Caddyfile, and
every Dockerfile runtime target. By default it also builds all Compose images.
Use --check-only for local linting without building the final images.
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
require_command openssl
docker compose version >/dev/null

fixture_dir=$(mktemp -d)
cleanup() {
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
ROUND_ACCESS_PASSWORD_HASH='$argon2id$v=19$m=47104,t=1,p=1$zJPvVe48N64JUa9MFlVhiw$b5Tznu0PxnA4TciY6qYe2BFPxncF1ePQaeNukHhH1cU'
export TURN_SHARED_SECRET TURN_TLS_CERT_FILE TURN_TLS_KEY_FILE
export ROUND_ACCESS_USER ROUND_ACCESS_PASSWORD_HASH

printf 'Validating Compose interpolation with temporary dummy fixtures...\n'
docker compose --env-file ops/production.env.example config --quiet

printf 'Validating deployment shell scripts...\n'
sh -n ops/turn/entrypoint.sh
bash -n ops/turn/probe.sh
bash ops/turn/probe.sh --help >/dev/null

caddy_image=${CADDY_IMAGE:-caddy:2.11.4-alpine}
printf 'Validating Caddy configuration...\n'
docker run --rm \
  -e ACME_EMAIL=ci@round.invalid \
  -e ROUND_ACCESS_PASSWORD_HASH \
  -e ROUND_ACCESS_USER \
  -e ROUND_DOMAIN=round.invalid \
  -v "$repo_root/ops/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  "$caddy_image" \
  caddy validate --config /etc/caddy/Caddyfile

printf 'Checking Dockerfile runtime targets...\n'
for target in web-runtime signaling-runtime turn-runtime; do
  docker build --check --target "$target" .
done

if "$check_only"; then
  printf 'Deployment checks passed; image builds skipped by --check-only.\n'
  exit 0
fi

printf 'Building all production Compose images...\n'
docker compose --env-file ops/production.env.example build --pull
printf 'Deployment validation passed.\n'
