#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=ops/linux/common.sh
source "$script_dir/common.sh"
umask 077

usage() {
  cat <<'EOF'
Usage: ops/linux/deploy.sh [--state-dir DIR] ENV_FILE

Deploys one immutable ROUND image set after the Linux preflight passes. The
verified release state includes image digests plus Compose/runtime-config
identities. An interrupted deployment remains marked for explicit rollback.
EOF
}

requested_state_dir=/var/lib/round/releases
case "${1:-}" in
  --state-dir)
    [[ $# == 3 ]] || {
      usage >&2
      exit 2
    }
    requested_state_dir=$2
    shift 2
    ;;
  -h | --help)
    usage
    exit 0
    ;;
esac
[[ $# == 1 ]] || {
  usage >&2
  exit 2
}

env_file=$1
repo_root=$(round_ops_repo_root)
cd "$repo_root"
for command_name in cmp openssl realpath; do
  round_ops_require_command "$command_name"
done
round_ops_require_private_file "$env_file"
round_ops_require_clean_checkout

requested_state_root=$(dirname -- "$requested_state_dir")
state_root=$(round_ops_prepare_private_directory "$requested_state_root")
state_dir=$(round_ops_prepare_private_directory \
  "$state_root/$(basename -- "$requested_state_dir")")
round_ops_acquire_lifecycle_lock "$state_root"

pending_file="$state_dir/pending.env"
in_progress_file="$state_dir/in-progress.env"
current_file="$state_dir/current.env"
previous_file="$state_dir/previous.env"
snapshot_dir=
deployment_started=false
[[ ! -e "$pending_file" ]] || round_ops_die "stale pending state exists: $pending_file"
[[ ! -e "$in_progress_file" ]] ||
  round_ops_die "an interrupted deployment is recorded; run rollback before deploying again"
for rollback_marker in rollback-pending.env rollback-in-progress.env rollback-origin.env; do
  [[ ! -e "$state_dir/$rollback_marker" ]] ||
    round_ops_die "an interrupted rollback is recorded; run rollback before deploying again"
done
if [[ -e "$current_file" ]]; then
  round_ops_validate_release_file "$current_file"
  current_edge_image=$(round_ops_read_env_value "$current_file" ROUND_EDGE_IMAGE)
  current_signaling_image=$(round_ops_read_env_value "$current_file" ROUND_SIGNALING_IMAGE)
  current_turn_image=$(round_ops_read_env_value "$current_file" ROUND_TURN_IMAGE)
  current_source_commit=$(round_ops_read_env_value "$current_file" ROUND_CHECKOUT_COMMIT)
  round_ops_verify_signed_provenance \
    "$current_source_commit" \
    "$current_edge_image" \
    "$current_signaling_image" \
    "$current_turn_image"
fi
if [[ -e "$previous_file" ]]; then
  [[ -e "$current_file" ]] ||
    round_ops_die "previous release state exists without a verified current release"
  round_ops_validate_release_file "$previous_file"
fi

cleanup_deployment() {
  local status=$?
  if [[ "$deployment_started" != true ]]; then
    rm -f -- "$pending_file"
  fi
  if [[ -n "$snapshot_dir" && -d "$snapshot_dir" ]]; then
    if ! round_ops_remove_deployment_snapshot "$state_root" "$snapshot_dir"; then
      status=1
    fi
  fi
  return "$status"
}
trap cleanup_deployment EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

snapshot_dir=$(round_ops_create_deployment_snapshot \
  "$state_root" \
  "$env_file" \
  "$repo_root/compose.yml")
snapshot_env_file="$snapshot_dir/runtime.env"
snapshot_compose_file="$snapshot_dir/compose.yml"

edge_image=$(round_ops_read_env_value "$snapshot_env_file" ROUND_EDGE_IMAGE)
signaling_image=$(round_ops_read_env_value "$snapshot_env_file" ROUND_SIGNALING_IMAGE)
turn_image=$(round_ops_read_env_value "$snapshot_env_file" ROUND_TURN_IMAGE)
round_ops_write_release_file \
  "$pending_file" \
  "$snapshot_env_file" \
  "$edge_image" \
  "$signaling_image" \
  "$turn_image" \
  "$snapshot_compose_file"
"$script_dir/preflight.sh" \
  --release-file "$pending_file" \
  --compose-file "$snapshot_compose_file" \
  --state-dir "$state_dir" \
  "$snapshot_env_file"

mv -- "$pending_file" "$in_progress_file"
deployment_started=true

round_ops_compose_with_file \
  "$snapshot_compose_file" \
  "$snapshot_env_file" \
  "$edge_image" "$signaling_image" "$turn_image" \
  pull edge signaling turn
round_ops_assert_state_compatible \
  "$in_progress_file" "$snapshot_env_file" "$snapshot_compose_file"
round_ops_verify_release_image_labels "$in_progress_file" "$snapshot_env_file"
round_ops_compose_with_file \
  "$snapshot_compose_file" \
  "$snapshot_env_file" \
  "$edge_image" "$signaling_image" "$turn_image" \
  up -d --wait --no-build --remove-orphans

if [[ -e "$current_file" ]] && ! cmp -s -- "$current_file" "$in_progress_file"; then
  round_ops_copy_release_file "$current_file" "$previous_file"
fi
mv -f -- "$in_progress_file" "$current_file"

printf 'ROUND deployment passed health checks; complete release state recorded in %s.\n' \
  "$current_file"
