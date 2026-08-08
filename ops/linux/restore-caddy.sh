#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=ops/linux/common.sh
source "$script_dir/common.sh"
umask 077

usage() {
  cat <<'EOF'
Usage: ops/linux/restore-caddy.sh [--state-dir DIR] --identity-file AGE_IDENTITY --confirm RESTORE_CADDY_VOLUMES BACKUP ENV_FILE

Destructively restores the Caddy ACME volumes from one encrypted backup. The
Compose project must already be down, including stopped containers. Missing
named volumes are created for fresh-host disaster recovery. The command does
not start ROUND; run the normal deploy command after inspecting success.
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
  round_ops_die "restore requires --confirm RESTORE_CADDY_VOLUMES"

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
  round_ops_die "encrypted backup is not a readable non-empty regular file: $backup_file"
[[ "$state_dir" == /* ]] || round_ops_die "release state directory must be absolute"

requested_state_root=$(dirname -- "$state_dir")
state_root=$(round_ops_prepare_private_directory "$requested_state_root")
state_dir=$(round_ops_prepare_private_directory "$state_root/$(basename -- "$state_dir")")
round_ops_acquire_lifecycle_lock "$state_root"
round_ops_docker info >/dev/null 2>&1 || round_ops_die "Docker Engine is unavailable"

if [[ -e "$backup_file.sha256" ]]; then
  [[ -f "$backup_file.sha256" && ! -L "$backup_file.sha256" ]] ||
    round_ops_die "backup checksum must be a regular file"
  expected_checksum=$(<"$backup_file.sha256")
  actual_checksum=$(openssl dgst -sha256 "$backup_file" | awk '{ print $NF }')
  [[ "$expected_checksum" =~ ^[0-9a-f]{64}$ ]] ||
    round_ops_die "backup checksum file is malformed"
  [[ "$actual_checksum" == "$expected_checksum" ]] ||
    round_ops_die "backup checksum does not match"
fi

current_file="$state_dir/current.env"
if [[ -e "$current_file" ]]; then
  round_ops_require_stable_release_state "$state_dir"
  round_ops_assert_state_compatible "$current_file" "$env_file"
  edge_image=$(round_ops_read_env_value "$current_file" ROUND_EDGE_IMAGE)
  signaling_image=$(round_ops_read_env_value "$current_file" ROUND_SIGNALING_IMAGE)
  turn_image=$(round_ops_read_env_value "$current_file" ROUND_TURN_IMAGE)
else
  edge_image=$(round_ops_read_env_value "$env_file" ROUND_EDGE_IMAGE)
  signaling_image=$(round_ops_read_env_value "$env_file" ROUND_SIGNALING_IMAGE)
  turn_image=$(round_ops_read_env_value "$env_file" ROUND_TURN_IMAGE)
  round_ops_validate_digest_ref ROUND_EDGE_IMAGE "$edge_image"
  round_ops_validate_digest_ref ROUND_SIGNALING_IMAGE "$signaling_image"
  round_ops_validate_digest_ref ROUND_TURN_IMAGE "$turn_image"
fi

[[ -z "$(round_ops_compose \
  "$env_file" "$edge_image" "$signaling_image" "$turn_image" ps --all -q)" ]] ||
  round_ops_die "Compose containers still exist; run docker compose down before restore"

caddy_data_volume=$(round_ops_compose_volume_name \
  "$env_file" "$edge_image" "$signaling_image" "$turn_image" caddy_data)
caddy_config_volume=$(round_ops_compose_volume_name \
  "$env_file" "$edge_image" "$signaling_image" "$turn_image" caddy_config)
project_name=$(round_ops_compose_project_name \
  "$env_file" "$edge_image" "$signaling_image" "$turn_image")

listing_file=$(mktemp)
verbose_listing_file=$(mktemp)
cleanup() {
  rm -f -- "$listing_file" "$verbose_listing_file"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

age --decrypt --identity "$identity_file" "$backup_file" | tar -tf - >"$listing_file"
age --decrypt --identity "$identity_file" "$backup_file" | tar -tvf - >"$verbose_listing_file"
grep -Eq '^caddy_data/?$' "$listing_file" || round_ops_die "backup has no caddy_data root"
grep -Eq '^caddy_config/?$' "$listing_file" || round_ops_die "backup has no caddy_config root"
if grep -Ev '^(caddy_data|caddy_config)(/.*)?$' "$listing_file" | grep -q .; then
  round_ops_die "backup contains an unexpected archive path"
fi
if grep -Eq '(^|/)\.\.?(/|$)' "$listing_file"; then
  round_ops_die "backup contains a path traversal component"
fi
if ! awk 'substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { exit 1 }' \
  "$verbose_listing_file"; then
  round_ops_die "backup contains a non-file archive entry"
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

age --decrypt --identity "$identity_file" "$backup_file" |
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
printf 'Caddy volumes restored. Inspect them, then run ops/linux/deploy.sh.\n'
