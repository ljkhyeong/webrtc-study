#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
unit_source=$repo_root/ops/linux/systemd

if ! command -v systemd-analyze >/dev/null 2>&1; then
  printf 'ROUND systemd unit verification skipped: systemd-analyze is unavailable.\n'
  exit 0
fi

fixture_dir=$(mktemp -d)
cleanup() {
  rm -rf -- "$fixture_dir"
}
trap cleanup EXIT

cp "$unit_source"/*.service "$unit_source"/*.timer "$fixture_dir/"
cat >"$fixture_dir/docker.service" <<'EOF'
[Unit]
Description=ROUND unit-validation Docker stub

[Service]
Type=oneshot
ExecStart=/bin/true
RemainAfterExit=yes
EOF

SYSTEMD_UNIT_PATH="$fixture_dir:" systemd-analyze verify \
  'round-ops-failure@round-backup.service.service'

printf 'ROUND systemd unit verification passed.\n'
