#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
fixture_dir=$(mktemp -d)
trap 'rm -rf -- "$fixture_dir"' EXIT

# 공개 설정과 가짜 웹훅만 사용하며 컨테이너는 읽기 전용으로 연결합니다.
cp "$repo_root"/ops/observability/*.yml "$fixture_dir/"
mkdir "$fixture_dir/optional-rules" "$fixture_dir/optional-scrapes"
printf 'https://example.invalid/round-ci\n' >"$fixture_dir/round-discord-webhook"
chmod -R a+rX "$fixture_dir"
export ROUND_OBSERVABILITY_FIXTURE_DIR="$fixture_dir"
compose=(docker compose --project-name "round-observability-check-$$"
  -f "$repo_root/ops/ci/compose.observability.yml")

printf 'Prometheus 기본 설정 검사\n'
"${compose[@]}" run --rm promtool check config /etc/prometheus/prometheus-local.yml

cp "$fixture_dir/round-turn-alerts.yml" "$fixture_dir/optional-rules/"
cp "$fixture_dir/scrape-turn-tls.yml" "$fixture_dir/optional-scrapes/"
chmod -R a+rX "$fixture_dir"
printf 'Prometheus 선택 연동과 경보 검사\n'
"${compose[@]}" run --rm promtool check config /etc/prometheus/prometheus-local.yml
"${compose[@]}" run --rm promtool check rules /etc/prometheus/round-external-alerts.yml
"${compose[@]}" run --rm promtool test rules round-turn-alerts.test.yml

printf 'Alertmanager 알림 설정 검사\n'
"${compose[@]}" run --rm amtool check-config /etc/alertmanager/alertmanager-discord.yml

printf 'Blackbox Exporter TLS 설정 검사\n'
"${compose[@]}" run --rm blackbox \
  --config.file=/etc/blackbox-exporter/blackbox-turn.yml --config.check
