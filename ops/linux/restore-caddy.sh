#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=ops/linux/common.sh
source "$script_dir/common.sh"
umask 077

usage() {
  cat <<'EOF'
사용법: ops/linux/restore-caddy.sh [--state-dir DIR] --identity-file AGE_IDENTITY --confirm RESTORE_CADDY_VOLUMES BACKUP ENV_FILE

암호화된 백업 하나에서 Caddy ACME 볼륨을 파괴적으로 복원합니다. 중지된 컨테이너를
포함해 Compose 프로젝트가 완전히 내려가 있어야 합니다. 신규 호스트 재해 복구에서는 없는
이름 있는 볼륨을 만듭니다. 이 명령은 ROUND를 시작하지 않으므로 결과를 확인한 뒤 일반 배포
명령을 실행하세요.
EOF
}

state_dir=/var/lib/round/releases
identity_file=
confirmation=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-dir)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit 2
      }
      state_dir=$2
      shift 2
      ;;
    --identity-file)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit 2
      }
      identity_file=$2
      shift 2
      ;;
    --confirm)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit 2
      }
      confirmation=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) break ;;
  esac
done
[[ $# == 2 && -n "$identity_file" ]] || {
  usage >&2
  exit 2
}
[[ "$confirmation" == 'RESTORE_CADDY_VOLUMES' ]] ||
  round_ops_die "복원하려면 --confirm RESTORE_CADDY_VOLUMES 확인값이 필요합니다"

backup_file=$1
env_file=$2
repo_root=$(round_ops_repo_root)
cd "$repo_root"
for command_name in age docker jq openssl realpath tar; do
  round_ops_require_command "$command_name"
done
round_ops_require_private_file "$env_file"
round_ops_require_private_file "$identity_file"
round_ops_require_clean_checkout
[[ -f "$backup_file" && ! -L "$backup_file" && -r "$backup_file" && -s "$backup_file" ]] ||
  round_ops_die "암호화 백업은 읽을 수 있는 비어 있지 않은 일반 파일이어야 합니다: $backup_file"
[[ "$state_dir" == /* ]] || round_ops_die "릴리스 상태 디렉터리는 절대 경로여야 합니다"

requested_state_root=$(dirname -- "$state_dir")
state_root=$(round_ops_prepare_private_directory "$requested_state_root")
state_dir=$(round_ops_prepare_private_directory "$state_root/$(basename -- "$state_dir")")
round_ops_acquire_lifecycle_lock "$state_root"

backup_snapshot=
listing_file=
verbose_listing_file=
cleanup() {
  local cleanup_file
  for cleanup_file in "$backup_snapshot" "$listing_file" "$verbose_listing_file"; do
    if [[ -n "$cleanup_file" ]]; then
      rm -f -- "$cleanup_file"
    fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

backup_snapshot=$(mktemp "$state_root/.restore-backup.XXXXXX") ||
  round_ops_die "암호화 백업 스냅샷을 만들지 못했습니다"
if ! cp -- "$backup_file" "$backup_snapshot" || ! chmod 0600 "$backup_snapshot"; then
  round_ops_die "암호화 백업을 mode 0600 스냅샷으로 고정하지 못했습니다"
fi
round_ops_require_private_file "$backup_snapshot"
[[ -s "$backup_snapshot" ]] || round_ops_die "암호화 백업 스냅샷이 비어 있습니다"

if [[ -e "$backup_file.sha256" ]]; then
  [[ -f "$backup_file.sha256" && ! -L "$backup_file.sha256" ]] ||
    round_ops_die "백업 체크섬은 일반 파일이어야 합니다"
  expected_checksum=$(<"$backup_file.sha256")
  actual_checksum=$(round_ops_sha256_file "$backup_snapshot")
  [[ "$expected_checksum" =~ ^[0-9a-f]{64}$ ]] ||
    round_ops_die "백업 체크섬 파일 형식이 올바르지 않습니다"
  [[ "$actual_checksum" == "$expected_checksum" ]] ||
    round_ops_die "백업 체크섬이 일치하지 않습니다"
fi

current_file="$state_dir/current.env"
if [[ -e "$current_file" ]]; then
  round_ops_require_stable_release_state "$state_dir"
  round_ops_assert_state_compatible "$current_file" "$env_file"
  edge_image=$(round_ops_read_env_value "$current_file" ROUND_EDGE_IMAGE)
  signaling_image=$(round_ops_read_env_value "$current_file" ROUND_SIGNALING_IMAGE)
  turn_image=$(round_ops_read_env_value "$current_file" ROUND_TURN_IMAGE)
  fresh_restore=false
else
  edge_image=$(round_ops_read_env_value "$env_file" ROUND_EDGE_IMAGE)
  signaling_image=$(round_ops_read_env_value "$env_file" ROUND_SIGNALING_IMAGE)
  turn_image=$(round_ops_read_env_value "$env_file" ROUND_TURN_IMAGE)
  source_commit=$(git rev-parse HEAD) ||
    round_ops_die "현재 ROUND checkout 커밋을 확인하지 못했습니다"
  fresh_restore=true
fi

compose_container_ids=$(round_ops_compose \
  "$env_file" "$edge_image" "$signaling_image" "$turn_image" ps --all -q) ||
  round_ops_die "Compose 컨테이너가 남아 있는지 확인하지 못했습니다"
[[ -z "$compose_container_ids" ]] ||
  round_ops_die "Compose 컨테이너가 남아 있습니다. 복원 전에 docker compose down을 실행하세요"

if "$fresh_restore"; then
  ice_transport_policy=$(round_ops_read_env_value "$env_file" VITE_ICE_TRANSPORT_POLICY)
  case "$ice_transport_policy" in
    all) expected_edge_flavor=standalone ;;
    relay) expected_edge_flavor=relay ;;
    *) round_ops_die "VITE_ICE_TRANSPORT_POLICY는 all 또는 relay여야 합니다" ;;
  esac
  round_ops_verify_restore_helper_image \
    "$edge_image" "$source_commit" "$expected_edge_flavor"
fi

compose_metadata=$(round_ops_compose \
  "$env_file" "$edge_image" "$signaling_image" "$turn_image" \
  config --format json)
project_name=$(jq -er '.name' <<<"$compose_metadata")
caddy_data_volume=$(jq -er '.volumes.caddy_data.name' <<<"$compose_metadata")
caddy_config_volume=$(jq -er '.volumes.caddy_config.name' <<<"$compose_metadata")

listing_file=$(mktemp)
verbose_listing_file=$(mktemp)
age --decrypt --identity "$identity_file" "$backup_snapshot" | tar -tf - >"$listing_file"
age --decrypt --identity "$identity_file" "$backup_snapshot" | tar -tvf - >"$verbose_listing_file"
grep -Eq '^caddy_data/?$' "$listing_file" || round_ops_die "백업에 caddy_data 최상위 경로가 없습니다"
grep -Eq '^caddy_config/?$' "$listing_file" || round_ops_die "백업에 caddy_config 최상위 경로가 없습니다"
if grep -Ev '^(caddy_data|caddy_config)(/.*)?$' "$listing_file" | grep -q .; then
  round_ops_die "백업에 허용하지 않은 아카이브 경로가 있습니다"
fi
if grep -Eq '(^|/)\.\.?(/|$)' "$listing_file"; then
  round_ops_die "백업에 상위 경로로 이동하는 항목이 있습니다"
fi
if ! awk 'substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { exit 1 }' \
  "$verbose_listing_file"; then
  round_ops_die "백업에 일반 파일이나 디렉터리가 아닌 항목이 있습니다"
fi

ensure_volume() {
  local logical_name=$1
  local volume_name=$2
  if ! round_ops_docker volume inspect "$volume_name" >/dev/null 2>&1; then
    round_ops_docker volume create \
      --label "com.docker.compose.project=$project_name" \
      --label "com.docker.compose.volume=$logical_name" \
      "$volume_name" \
      >/dev/null
  fi
}
ensure_volume caddy_data "$caddy_data_volume"
ensure_volume caddy_config "$caddy_config_volume"

age --decrypt --identity "$identity_file" "$backup_snapshot" |
  round_ops_docker run --rm --interactive \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --user 0:0 \
    --volume "$caddy_data_volume:/restore/caddy_data" \
    --volume "$caddy_config_volume:/restore/caddy_config" \
    --entrypoint sh \
    "$edge_image" \
    -ceu '
      find /restore/caddy_data -mindepth 1 -exec rm -rf -- {} \;
      find /restore/caddy_config -mindepth 1 -exec rm -rf -- {} \;
      tar -C /restore -xf -
    '

trap - EXIT INT TERM
cleanup
printf 'Caddy 볼륨을 복원했습니다. 내용을 확인한 뒤 ops/linux/deploy.sh를 실행하세요.\n'
