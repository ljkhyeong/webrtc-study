#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
probe=$repo_root/ops/turn/probe.sh
test_root=$(mktemp -d)
fake_bin=$test_root/bin
docker_log=$test_root/docker-arguments.log
private_ca=$test_root/private-ca.pem

cleanup() {
  rm -rf -- "$test_root"
}
trap cleanup EXIT

fail() {
  printf 'round-turn-probe-test: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local expected=$1
  local source=$2
  local label=$3
  grep -Fq -- "$expected" "$source" || fail "$label"
}

assert_not_contains() {
  local unexpected=$1
  local source=$2
  local label=$3
  if grep -Fq -- "$unexpected" "$source"; then
    fail "$label"
  fi
}

mkdir -m 0700 -- "$fake_bin"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -Eeuo pipefail' \
  'output=' \
  'while (( $# > 0 )); do' \
  '  case "$1" in' \
  '    --output) output=$2; shift 2 ;;' \
  '    *) shift ;;' \
  '  esac' \
  'done' \
  '[[ -n "$output" ]]' \
  'expires_at=$(($(date +%s) + 600))' \
  'printf '\''{"urls":["turn:turn.example.test:3478?transport=udp","turn:turn.example.test:3478?transport=tcp","turns:turn.example.test:5349?transport=tcp"],"username":"probe-user","credential":"probe-credential","expiresAt":%s}\n'\'' "$expires_at" >"$output"' \
  >"$fake_bin/curl"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -Eeuo pipefail' \
  ': "${DOCKER_ARGUMENTS_FILE:?}"' \
  'printf '\''container-ca=%s\n'\'' "${TURN_PROBE_TLS_CA_FILE:-}" >"$DOCKER_ARGUMENTS_FILE"' \
  'for argument in "$@"; do' \
  '  printf '\''argument=%s\n'\'' "$argument" >>"$DOCKER_ARGUMENTS_FILE"' \
  '  case "$argument" in' \
  '    type=bind,source=*,target=/run/round-turn-probe/ca.pem,readonly)' \
  '      source=${argument#type=bind,source=}' \
  '      source=${source%,target=/run/round-turn-probe/ca.pem,readonly}' \
  '      if [[ -n "${EXPECTED_CA_FILE:-}" ]] && cmp -s -- "$source" "$EXPECTED_CA_FILE"; then' \
  '        printf '\''private-ca-snapshot=matched\n'\'' >>"$DOCKER_ARGUMENTS_FILE"' \
  '      else' \
  '        printf '\''private-ca-snapshot=mismatched\n'\'' >>"$DOCKER_ARGUMENTS_FILE"' \
  '      fi' \
  '      ;;' \
  '  esac' \
  'done' \
  >"$fake_bin/docker"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'exit 0' \
  >"$fake_bin/openssl"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -Eeuo pipefail' \
  'shift' \
  'exec "$@"' \
  >"$fake_bin/timeout"

chmod 0700 \
  "$fake_bin/curl" \
  "$fake_bin/docker" \
  "$fake_bin/openssl" \
  "$fake_bin/timeout"
printf '%s\n' 'private test CA' >"$private_ca"
chmod 0600 "$private_ca"

run_probe() {
  local ca_file=${1:-}
  PATH="$fake_bin:$PATH" \
  DOCKER_ARGUMENTS_FILE="$docker_log" \
  EXPECTED_CA_FILE="$private_ca" \
  ROUND_URL=https://round.example.test \
  ROUND_ACCESS_USER=round-probe \
  ROUND_ACCESS_PASSWORD=probe-password \
  TURN_PROBE_HOST=turn.example.test \
  TURN_PROBE_TRANSPORTS=tls \
  TURN_PROBE_CA_FILE="$ca_file" \
    bash "$probe" >/dev/null
}

run_probe "$private_ca"
assert_contains 'container-ca=/run/round-turn-probe/ca.pem' "$docker_log" \
  'private CA path was not selected inside the probe container'
assert_contains 'target=/run/round-turn-probe/ca.pem,readonly' "$docker_log" \
  'private CA snapshot was not mounted read-only'
assert_contains 'private-ca-snapshot=matched' "$docker_log" \
  'mounted private CA snapshot does not match the configured CA'
assert_contains 'argument=TURN_PROBE_TLS_CA_FILE' "$docker_log" \
  'container CA path environment was not forwarded by name'
assert_contains '-E "$TURN_PROBE_TLS_CA_FILE"' "$docker_log" \
  'TLS relay client does not use the selected CA path'
assert_not_contains "source=$private_ca," "$docker_log" \
  'operator-owned CA path was mounted directly instead of a private snapshot'

run_probe
assert_contains 'container-ca=/etc/ssl/certs/ca-certificates.crt' "$docker_log" \
  'default container trust store was not selected'
assert_not_contains 'target=/run/round-turn-probe/ca.pem,readonly' "$docker_log" \
  'a private CA mount was added without TURN_PROBE_CA_FILE'

if run_probe "$test_root/missing-ca.pem" 2>/dev/null; then
  fail 'missing TURN_PROBE_CA_FILE was accepted'
fi

printf 'TURN probe private CA propagation checks passed.\n'
