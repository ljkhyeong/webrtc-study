#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=ops/linux/common.sh
source "$script_dir/common.sh"
umask 077

usage() {
  cat <<'EOF'
Usage: ops/linux/reload-turn-certificate.sh [OPTIONS] ENV_FILE

Options:
  --release-state-dir DIR       Verified deployment state (default: /var/lib/round/releases)
  --certificate-state-dir DIR   Applied fingerprint state (default: /var/lib/round/certificates)
  --check-host HOST             coturn TLS listener address (default: 127.0.0.1)
  --check-port PORT             coturn TLS listener port (default: 5349)
  --tls-ca-file FILE            Optional private CA for listener verification

Validates key matching, hostname, and at least seven days of remaining validity
before recreating TURN from the currently verified release. An unchanged
certificate fingerprint is a successful no-op.
EOF
}

release_state_dir=/var/lib/round/releases
certificate_state_dir=/var/lib/round/certificates
check_host=127.0.0.1
check_port=5349
tls_ca_file=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release-state-dir)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit 2
      }
      release_state_dir=$2
      shift 2
      ;;
    --certificate-state-dir)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit 2
      }
      certificate_state_dir=$2
      shift 2
      ;;
    --check-host)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit 2
      }
      check_host=$2
      shift 2
      ;;
    --check-port)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit 2
      }
      check_port=$2
      shift 2
      ;;
    --tls-ca-file)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit 2
      }
      tls_ca_file=$2
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

env_file=$1
repo_root=$(round_ops_repo_root)
cd "$repo_root"
for command_name in docker openssl realpath timeout; do
  round_ops_require_command "$command_name"
done
round_ops_require_private_file "$env_file"
round_ops_require_clean_checkout
[[ "$release_state_dir" == /* && "$certificate_state_dir" == /* ]] ||
  round_ops_die "state directories must be absolute"
round_ops_require_private_directory "$release_state_dir"
state_root=$(dirname -- "$release_state_dir")
round_ops_require_private_directory "$state_root"
certificate_state_dir=$(round_ops_prepare_private_directory "$certificate_state_dir")
round_ops_acquire_lifecycle_lock "$state_root"

current_file="$release_state_dir/current.env"
round_ops_require_stable_release_state "$release_state_dir"
round_ops_assert_state_compatible "$current_file" "$env_file"
edge_image=$(round_ops_read_env_value "$current_file" ROUND_EDGE_IMAGE)
signaling_image=$(round_ops_read_env_value "$current_file" ROUND_SIGNALING_IMAGE)
turn_image=$(round_ops_read_env_value "$current_file" ROUND_TURN_IMAGE)

round_ops_validate_certificate "$env_file" $((7 * 24 * 60 * 60))
round_ops_docker info >/dev/null 2>&1 || round_ops_die "Docker Engine is unavailable"

fingerprint=$(round_ops_turn_certificate_fingerprint "$env_file")

fingerprint_file="$certificate_state_dir/turn-certificate.sha256"
if [[ -e "$fingerprint_file" ]]; then
  round_ops_require_private_file "$fingerprint_file"
  if [[ "$(<"$fingerprint_file")" == "$fingerprint" ]]; then
    if (round_ops_verify_turn_tls_listener \
      "$env_file" "$check_host" "$check_port" "$tls_ca_file" \
      >/dev/null); then
      printf 'TURN certificate fingerprint and live TLS listener are unchanged; no container restart is needed.\n'
      exit 0
    fi
    round_ops_error "recorded fingerprint is current but the listener is stale; recreating TURN"
  fi
fi

round_ops_compose "$env_file" "$edge_image" "$signaling_image" "$turn_image" \
  up -d --wait --no-build --no-deps --force-recreate turn
round_ops_verify_turn_tls_listener \
  "$env_file" "$check_host" "$check_port" "$tls_ca_file" \
  >/dev/null
temporary=$(mktemp "$certificate_state_dir/.turn-certificate.XXXXXX")
chmod 0600 "$temporary"
printf '%s\n' "$fingerprint" >"$temporary"
mv -f -- "$temporary" "$fingerprint_file"

printf 'TURN certificate validated and the verified TURN release was recreated successfully.\n'
