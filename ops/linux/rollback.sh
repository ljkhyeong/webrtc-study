#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=ops/linux/common.sh
source "$script_dir/common.sh"
umask 077

usage() {
  cat <<'EOF'
Usage: ops/linux/rollback.sh [--state-dir DIR] --confirm ROLLBACK_ROUND ENV_FILE

Recovers an interrupted deploy/rollback first. With no recovery journal, it
swaps the verified current and previous releases. A failed first deployment has
no prior release, so recovery brings the Compose project fully down. Active
rooms and sockets are lost; every browser must reload and rejoin.
EOF
}

state_dir=/var/lib/round/releases
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
[[ $# == 1 ]] || {
  usage >&2
  exit 2
}
[[ "$confirmation" == 'ROLLBACK_ROUND' ]] ||
  round_ops_die "rollback requires --confirm ROLLBACK_ROUND"

env_file=$1
repo_root=$(round_ops_repo_root)
cd "$repo_root"
for command_name in cmp openssl realpath; do
  round_ops_require_command "$command_name"
done
round_ops_require_private_file "$env_file"
round_ops_require_clean_checkout
[[ "$state_dir" == /* ]] || round_ops_die "release state directory must be absolute"
round_ops_require_private_directory "$state_dir"
state_root=$(dirname -- "$state_dir")
round_ops_require_private_directory "$state_root"
round_ops_acquire_lifecycle_lock "$state_root"

current_file="$state_dir/current.env"
previous_file="$state_dir/previous.env"
deploy_marker="$state_dir/in-progress.env"
rollback_pending="$state_dir/rollback-pending.env"
rollback_marker="$state_dir/rollback-in-progress.env"
rollback_origin="$state_dir/rollback-origin.env"
[[ ! -e "$state_dir/pending.env" ]] ||
  round_ops_die "stale deploy pending state exists; inspect it before recovery"
[[ ! -e "$rollback_pending" ]] ||
  round_ops_die "stale rollback pending state exists; inspect it before recovery"
[[ ! ( -e "$deploy_marker" && -e "$rollback_marker" ) ]] ||
  round_ops_die "deploy and rollback journals both exist; manual state inspection is required"

snapshot_dir=
rollback_pending_created=false
rollback_origin_created=false
cleanup_rollback() {
  local status=$?
  if [[ "$rollback_pending_created" == true ]]; then
    rm -f -- "$rollback_pending"
  fi
  if [[ "$rollback_origin_created" == true && ! -e "$rollback_marker" ]]; then
    rm -f -- "$rollback_origin"
  fi
  if [[ -n "$snapshot_dir" && -d "$snapshot_dir" ]]; then
    if ! round_ops_remove_deployment_snapshot "$state_root" "$snapshot_dir"; then
      status=1
    fi
  fi
  return "$status"
}
trap cleanup_rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

snapshot_dir=$(round_ops_create_deployment_snapshot \
  "$state_root" \
  "$env_file" \
  "$repo_root/compose.yml")
snapshot_env_file="$snapshot_dir/runtime.env"
snapshot_compose_file="$snapshot_dir/compose.yml"

mode=
target_file=
if [[ -e "$rollback_marker" ]]; then
  round_ops_validate_release_file "$rollback_marker"
  round_ops_validate_release_file "$current_file"
  if [[ -e "$rollback_origin" ]]; then
    round_ops_validate_release_file "$rollback_origin"
  fi
  target_file=$current_file
  if cmp -s -- "$current_file" "$rollback_marker"; then
    mode=finish_interrupted_rollback
  else
    [[ -e "$rollback_origin" ]] ||
      round_ops_die "rollback journal has no origin state; manual inspection is required"
    mode=recover_interrupted_rollback
  fi
elif [[ -e "$deploy_marker" ]]; then
  round_ops_validate_release_file "$deploy_marker"
  if [[ ! -e "$current_file" ]]; then
    round_ops_assert_state_compatible \
      "$deploy_marker" "$snapshot_env_file" "$snapshot_compose_file"
    edge_image=$(round_ops_read_env_value "$deploy_marker" ROUND_EDGE_IMAGE)
    signaling_image=$(round_ops_read_env_value "$deploy_marker" ROUND_SIGNALING_IMAGE)
    turn_image=$(round_ops_read_env_value "$deploy_marker" ROUND_TURN_IMAGE)
    round_ops_compose_with_file \
      "$snapshot_compose_file" "$snapshot_env_file" \
      "$edge_image" "$signaling_image" "$turn_image" \
      config --quiet
    round_ops_compose_with_file \
      "$snapshot_compose_file" "$snapshot_env_file" \
      "$edge_image" "$signaling_image" "$turn_image" \
      down --remove-orphans
    remaining_containers=$(
      round_ops_compose_with_file \
        "$snapshot_compose_file" "$snapshot_env_file" \
        "$edge_image" "$signaling_image" "$turn_image" \
        ps --all -q
    )
    [[ -z "$remaining_containers" ]] ||
      round_ops_die "failed first deployment still has Compose containers"
    rm -f -- "$deploy_marker"
    printf 'ROUND first-deployment recovery passed; no verified prior release existed, so the Compose project is stopped.\n'
    exit 0
  fi
  round_ops_validate_release_file "$current_file"
  target_file=$current_file
  mode=recover_interrupted_deploy
else
  [[ ! -e "$rollback_origin" ]] ||
    round_ops_die "orphaned rollback origin exists; manual state inspection is required"
  rollback_pending_created=true
  round_ops_copy_release_file "$previous_file" "$rollback_pending"
  rollback_origin_created=true
  round_ops_copy_release_file "$current_file" "$rollback_origin"
  "$script_dir/preflight.sh" \
    --release-file "$rollback_pending" \
    --compose-file "$snapshot_compose_file" \
    --state-dir "$state_dir" \
    "$snapshot_env_file"
  mv -- "$rollback_pending" "$rollback_marker"
  target_file=$rollback_marker
  mode=normal_rollback
fi

round_ops_assert_state_compatible \
  "$target_file" "$snapshot_env_file" "$snapshot_compose_file"
edge_image=$(round_ops_read_env_value "$target_file" ROUND_EDGE_IMAGE)
signaling_image=$(round_ops_read_env_value "$target_file" ROUND_SIGNALING_IMAGE)
turn_image=$(round_ops_read_env_value "$target_file" ROUND_TURN_IMAGE)
if [[ "$mode" != normal_rollback ]]; then
  "$script_dir/preflight.sh" \
    --release-file "$target_file" \
    --compose-file "$snapshot_compose_file" \
    --state-dir "$state_dir" \
    "$snapshot_env_file"
fi

round_ops_compose_with_file \
  "$snapshot_compose_file" "$snapshot_env_file" \
  "$edge_image" "$signaling_image" "$turn_image" \
  pull edge signaling turn
round_ops_assert_state_compatible \
  "$target_file" "$snapshot_env_file" "$snapshot_compose_file"
round_ops_verify_release_image_labels "$target_file" "$snapshot_env_file"
round_ops_compose_with_file \
  "$snapshot_compose_file" "$snapshot_env_file" \
  "$edge_image" "$signaling_image" "$turn_image" \
  up -d --wait --no-build --remove-orphans

case "$mode" in
  normal_rollback)
    round_ops_copy_release_file "$rollback_marker" "$current_file"
    round_ops_copy_release_file "$rollback_origin" "$previous_file"
    rm -f -- "$rollback_origin" "$rollback_marker"
    result_message='previous release restored and the replaced release preserved for roll-forward'
    ;;
  recover_interrupted_deploy)
    rm -f -- "$deploy_marker"
    result_message='interrupted deployment recovered to the last verified release'
    ;;
  recover_interrupted_rollback)
    rm -f -- "$rollback_origin" "$rollback_marker"
    result_message='interrupted rollback was undone to the last verified release'
    ;;
  finish_interrupted_rollback)
    if [[ -e "$rollback_origin" ]]; then
      round_ops_copy_release_file "$rollback_origin" "$previous_file"
    fi
    rm -f -- "$rollback_origin" "$rollback_marker"
    result_message='verified rollback state transition was finalized'
    ;;
  *) round_ops_die "unknown rollback recovery mode: $mode" ;;
esac

printf 'ROUND rollback passed health checks; %s. Reload and rejoin every active browser.\n' \
  "$result_message"
