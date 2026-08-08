#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
resolver=$repo_root/ops/turn/resolve-external-pilot-target.sh
test_root=$(mktemp -d)

cleanup() {
  rm -rf -- "$test_root"
}
trap cleanup EXIT

fail() {
  printf 'external-turn-target-test: %s\n' "$*" >&2
  exit 1
}

write_target() {
  local path=$1
  local round_url=$2
  local turn_host=$3
  local image_repository=${4:-coturn/coturn}
  printf '%s\n' \
    "ROUND_URL=$round_url" \
    "TURN_PROBE_HOST=$turn_host" \
    "TURN_PROBE_IMAGE=$image_repository@sha256:d3a11e8f6d9e1b0454531e307684a072bdd36c36b28daafb4f082aa1e5ebd2e4" \
    >"$path"
}

assert_rejected() {
  local path=$1
  local label=$2
  if bash "$resolver" "$path" >/dev/null 2>&1; then
    fail "$label"
  fi
}

committed_actual=$(bash "$resolver" "$repo_root/ops/turn/external-pilot-target.properties")
committed_expected=$(printf '%s\n' \
  'round_url=https://round.b4ton.com' \
  'turn_host=turn.b4ton.com' \
  'probe_image=coturn/coturn@sha256:d3a11e8f6d9e1b0454531e307684a072bdd36c36b28daafb4f082aa1e5ebd2e4')
[[ "$committed_actual" == "$committed_expected" ]] ||
  fail 'committed b4ton target outputs were not exact'

valid_target=$test_root/valid.properties
write_target \
  "$valid_target" \
  https://round.pilot.test:443 \
  turn.pilot.test
actual=$(bash "$resolver" "$valid_target")
expected=$(printf '%s\n' \
  'round_url=https://round.pilot.test:443' \
  'turn_host=turn.pilot.test' \
  'probe_image=coturn/coturn@sha256:d3a11e8f6d9e1b0454531e307684a072bdd36c36b28daafb4f082aa1e5ebd2e4')
[[ "$actual" == "$expected" ]] || fail 'valid target outputs were not exact'

reserved_round_target=$test_root/reserved-round.properties
write_target \
  "$reserved_round_target" \
  https://ROUND.EXAMPLE.COM:443 \
  turn.pilot.test
assert_rejected "$reserved_round_target" 'reserved ROUND host variant was accepted'

reserved_turn_target=$test_root/reserved-turn.properties
write_target \
  "$reserved_turn_target" \
  https://round.pilot.test \
  TURN.EXAMPLE.COM.
assert_rejected "$reserved_turn_target" 'reserved TURN host variant was accepted'

untrusted_image_target=$test_root/untrusted-image.properties
write_target \
  "$untrusted_image_target" \
  https://round.pilot.test \
  turn.pilot.test \
  untrusted/probe
assert_rejected "$untrusted_image_target" 'untrusted image repository was accepted'

duplicate_target=$test_root/duplicate.properties
printf '%s\n' \
  'ROUND_URL=https://round.pilot.test' \
  'ROUND_URL=https://other.pilot.test' \
  'TURN_PROBE_HOST=turn.pilot.test' \
  'TURN_PROBE_IMAGE=coturn/coturn@sha256:d3a11e8f6d9e1b0454531e307684a072bdd36c36b28daafb4f082aa1e5ebd2e4' \
  >"$duplicate_target"
assert_rejected "$duplicate_target" 'duplicate target property was accepted'

unknown_target=$test_root/unknown.properties
printf '%s\n' \
  'ROUND_URL=https://round.pilot.test' \
  'TURN_PROBE_HOST=turn.pilot.test' \
  'TURN_PROBE_IMAGE=coturn/coturn@sha256:d3a11e8f6d9e1b0454531e307684a072bdd36c36b28daafb4f082aa1e5ebd2e4' \
  'UNEXPECTED=value' \
  >"$unknown_target"
assert_rejected "$unknown_target" 'unknown target property was accepted'

printf 'External TURN pilot target checks passed.\n'
