#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=ops/linux/common.sh
source "$script_dir/common.sh"
umask 077

usage() {
  cat <<'EOF'
Usage: ops/linux/backup-caddy.sh [--state-dir DIR] --recipient-file AGE_RECIPIENTS --output-dir DIR ENV_FILE

Creates an age-encrypted backup of the two Caddy ACME volumes. If edge is
running it is stopped for a consistent snapshot and restarted from the current
verified release before success is reported. Keep recipient private keys off-host.
EOF
}

state_dir=/var/lib/round/releases
recipient_file=
output_dir=
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
    --recipient-file)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit 2
      }
      recipient_file=$2
      shift 2
      ;;
    --output-dir)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit 2
      }
      output_dir=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) break ;;
  esac
done
[[ $# == 1 && -n "$recipient_file" && -n "$output_dir" ]] || {
  usage >&2
  exit 2
}

env_file=$1
repo_root=$(round_ops_repo_root)
cd "$repo_root"
for command_name in age docker jq openssl realpath; do
  round_ops_require_command "$command_name"
done
round_ops_require_private_file "$env_file"
round_ops_require_clean_checkout
[[ -f "$recipient_file" && ! -L "$recipient_file" && -r "$recipient_file" ]] ||
  round_ops_die "age recipient file is not a readable regular file: $recipient_file"
[[ "$state_dir" == /* ]] || round_ops_die "release state directory must be absolute"
round_ops_require_private_directory "$state_dir"
state_root=$(dirname -- "$state_dir")
round_ops_require_private_directory "$state_root"
output_dir=$(round_ops_prepare_private_directory "$output_dir")
round_ops_acquire_lifecycle_lock "$state_root"
round_ops_docker info >/dev/null 2>&1 || round_ops_die "Docker Engine is unavailable"

current_file="$state_dir/current.env"
round_ops_require_stable_release_state "$state_dir"
round_ops_assert_state_compatible "$current_file" "$env_file"
edge_image=$(round_ops_read_env_value "$current_file" ROUND_EDGE_IMAGE)
signaling_image=$(round_ops_read_env_value "$current_file" ROUND_SIGNALING_IMAGE)
turn_image=$(round_ops_read_env_value "$current_file" ROUND_TURN_IMAGE)
caddy_data_volume=$(round_ops_compose_volume_name \
  "$env_file" "$edge_image" "$signaling_image" "$turn_image" caddy_data)
caddy_config_volume=$(round_ops_compose_volume_name \
  "$env_file" "$edge_image" "$signaling_image" "$turn_image" caddy_config)
round_ops_docker volume inspect "$caddy_data_volume" >/dev/null
round_ops_docker volume inspect "$caddy_config_volume" >/dev/null

timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
backup_file="$output_dir/round-caddy-$timestamp.tar.age"
[[ ! -e "$backup_file" && ! -e "$backup_file.sha256" ]] ||
  round_ops_die "backup destination already exists: $backup_file"
temporary=$(mktemp "$output_dir/.round-caddy-backup.XXXXXX")
checksum_temporary=$(mktemp "$output_dir/.round-caddy-checksum.XXXXXX")
edge_was_running=false

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [[ "$edge_was_running" == true ]]; then
    round_ops_compose "$env_file" "$edge_image" "$signaling_image" "$turn_image" \
      up -d --wait --no-build --no-deps edge || exit_code=$?
  fi
  rm -f -- "$temporary" "$checksum_temporary"
  return "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -n "$(round_ops_compose \
  "$env_file" "$edge_image" "$signaling_image" "$turn_image" \
  ps --status running -q edge)" ]]; then
  edge_was_running=true
  round_ops_compose "$env_file" "$edge_image" "$signaling_image" "$turn_image" stop edge
fi

round_ops_docker run --rm --interactive \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user 0:0 \
  --volume "$caddy_data_volume:/round-backup/caddy_data:ro" \
  --volume "$caddy_config_volume:/round-backup/caddy_config:ro" \
  --entrypoint tar \
  "$edge_image" \
  -C /round-backup -cf - caddy_data caddy_config |
  age --recipients-file "$recipient_file" >"$temporary"

[[ -s "$temporary" ]] || round_ops_die "encrypted Caddy backup is empty"
chmod 0600 "$temporary"
mv -f -- "$temporary" "$backup_file"
checksum=$(round_ops_sha256_file "$backup_file")
printf '%s\n' "$checksum" >"$checksum_temporary"
chmod 0600 "$checksum_temporary"
mv -f -- "$checksum_temporary" "$backup_file.sha256"

if [[ "$edge_was_running" == true ]]; then
  round_ops_compose "$env_file" "$edge_image" "$signaling_image" "$turn_image" \
    up -d --wait --no-build --no-deps edge
  edge_was_running=false
fi
trap - EXIT INT TERM

printf 'Encrypted Caddy backup created: %s\n' "$backup_file"
