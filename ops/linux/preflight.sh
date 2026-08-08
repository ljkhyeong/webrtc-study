#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=ops/linux/common.sh
source "$script_dir/common.sh"

usage() {
  cat <<'EOF'
Usage: ops/linux/preflight.sh [OPTIONS] ENV_FILE

Options:
  --minimum-certificate-validity-days DAYS
  --release-file FILE   Validate and render the immutable images saved in FILE.
  --state-dir DIR       Include the release-state filesystem in disk checks.

Read-only production-host gate for ROUND. It validates Linux/Docker readiness,
the private env file, immutable image references, Compose interpolation, clock
synchronization, free disk, and the TURN certificate/key/hostname boundary.
EOF
}

minimum_validity_days=14
release_file=
state_dir=/var/lib/round/releases
while [[ $# -gt 0 ]]; do
  case "$1" in
    --minimum-certificate-validity-days)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit 2
      }
      minimum_validity_days=$2
      shift 2
      ;;
    --release-file)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit 2
      }
      release_file=$2
      shift 2
      ;;
    --state-dir)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit 2
      }
      state_dir=$2
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
[[ "$minimum_validity_days" =~ ^[1-9][0-9]*$ ]] ||
  round_ops_die "minimum certificate validity must be a positive number of days"
(( minimum_validity_days <= 3650 )) ||
  round_ops_die "minimum certificate validity cannot exceed 3650 days"

env_file=$1
repo_root=$(round_ops_repo_root)
cd "$repo_root"

[[ "$(uname -s)" == 'Linux' ]] || round_ops_die "production preflight must run on Linux"
for command_name in df docker jq openssl realpath timedatectl; do
  round_ops_require_command "$command_name"
done
round_ops_require_private_file "$env_file"
[[ "$state_dir" == /* ]] || round_ops_die "release state directory must be absolute"
[[ -d "$state_dir" ]] || round_ops_die "release state directory does not exist: $state_dir"
round_ops_require_private_directory "$state_dir"
round_ops_require_compose_version
round_ops_docker info >/dev/null 2>&1 || round_ops_die "Docker Engine is unavailable"

clock_synchronized=$(timedatectl show --property=NTPSynchronized --value 2>/dev/null) ||
  round_ops_die "could not verify host clock synchronization"
[[ "$clock_synchronized" == 'yes' ]] || round_ops_die "host clock is not NTP-synchronized"

minimum_available_kib=$((5 * 1024 * 1024))
docker_root=$(round_ops_docker info --format '{{.DockerRootDir}}') ||
  round_ops_die "could not determine the Docker data root"
[[ "$docker_root" == /* && -d "$docker_root" ]] ||
  round_ops_die "Docker data root is not an absolute directory: $docker_root"
for disk_target in "$repo_root" "$docker_root" "$state_dir"; do
  available_kib=$(df -Pk "$disk_target" | awk 'NR == 2 { print $4 }')
  [[ "$available_kib" =~ ^[0-9]+$ ]] ||
    round_ops_die "could not determine available disk space for $disk_target"
  (( available_kib >= minimum_available_kib )) ||
    round_ops_die "less than 5 GiB is available on the filesystem for $disk_target"
done

if [[ -n "$release_file" ]]; then
  round_ops_assert_state_compatible "$release_file" "$env_file"
  edge_image=$(round_ops_read_env_value "$release_file" ROUND_EDGE_IMAGE)
  signaling_image=$(round_ops_read_env_value "$release_file" ROUND_SIGNALING_IMAGE)
  turn_image=$(round_ops_read_env_value "$release_file" ROUND_TURN_IMAGE)
else
  edge_image=$(round_ops_read_env_value "$env_file" ROUND_EDGE_IMAGE)
  signaling_image=$(round_ops_read_env_value "$env_file" ROUND_SIGNALING_IMAGE)
  turn_image=$(round_ops_read_env_value "$env_file" ROUND_TURN_IMAGE)
  round_ops_validate_digest_ref ROUND_EDGE_IMAGE "$edge_image"
  round_ops_validate_digest_ref ROUND_SIGNALING_IMAGE "$signaling_image"
  round_ops_validate_digest_ref ROUND_TURN_IMAGE "$turn_image"
fi

round_domain=$(round_ops_read_env_value "$env_file" ROUND_DOMAIN)
allowed_origins=$(round_ops_read_env_value "$env_file" ALLOWED_ORIGINS)
turn_realm=$(round_ops_read_env_value "$env_file" TURN_REALM)
turn_external_ip=$(round_ops_read_env_value "$env_file" TURN_EXTERNAL_IP)
turn_relay_ip=$(round_ops_read_env_value "$env_file" TURN_RELAY_IP)
turn_min_port=$(round_ops_read_env_value "$env_file" TURN_MIN_PORT)
turn_max_port=$(round_ops_read_env_value "$env_file" TURN_MAX_PORT)
access_password_hash=$(round_ops_read_env_value "$env_file" ROUND_ACCESS_PASSWORD_HASH)
turn_shared_secret=$(round_ops_read_env_value "$env_file" TURN_SHARED_SECRET)
[[ "$allowed_origins" == "https://$round_domain" ]] ||
  round_ops_die "ALLOWED_ORIGINS must equal the exact ROUND_DOMAIN HTTPS origin"
[[ "$turn_realm" != "$round_domain" ]] ||
  round_ops_die "TURN_REALM and ROUND_DOMAIN must use separate hostnames"
for hostname in "$round_domain" "$turn_realm"; do
  [[ "$hostname" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$ ]] ||
    round_ops_die "invalid deployment hostname: $hostname"
  [[ "$hostname" == *.* && "$hostname" != *..* && "$hostname" != *.-* && "$hostname" != *-.* ]] ||
    round_ops_die "invalid deployment hostname: $hostname"
done
for address in "$turn_external_ip" "$turn_relay_ip"; do
  IFS=. read -r octet_1 octet_2 octet_3 octet_4 extra <<<"$address"
  [[ -z "${extra:-}" ]] || round_ops_die "TURN address must be IPv4: $address"
  for octet in "$octet_1" "$octet_2" "$octet_3" "$octet_4"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] || round_ops_die "TURN address must be IPv4: $address"
    (( 10#$octet <= 255 )) || round_ops_die "TURN address must be IPv4: $address"
  done
done
[[ "$turn_min_port" =~ ^[0-9]+$ && "$turn_max_port" =~ ^[0-9]+$ ]] ||
  round_ops_die "TURN relay ports must be integers"
(( turn_min_port >= 1024 && turn_max_port <= 65535 && turn_max_port >= turn_min_port )) ||
  round_ops_die "TURN relay port range is invalid"
(( turn_max_port - turn_min_port + 1 >= 100 )) ||
  round_ops_die "TURN relay range must provide at least 100 UDP ports"
[[ "$access_password_hash" =~ ^\'\$2[ab]\$12\$[./A-Za-z0-9]{53}\'$ ]] ||
  round_ops_die "ROUND_ACCESS_PASSWORD_HASH must be a single-quoted bcrypt cost-12 hash"
[[ "$turn_shared_secret" =~ ^[A-Fa-f0-9]{64,}$ ]] ||
  round_ops_die "TURN_SHARED_SECRET must contain at least 64 hexadecimal characters"

minimum_validity_seconds=$((minimum_validity_days * 24 * 60 * 60))
round_ops_validate_certificate "$env_file" "$minimum_validity_seconds"

round_ops_compose "$env_file" "$edge_image" "$signaling_image" "$turn_image" config --quiet
replicas=$(
  round_ops_compose "$env_file" "$edge_image" "$signaling_image" "$turn_image" \
    config --format json |
    jq -er '.services.signaling.deploy.replicas'
)
[[ "$replicas" == '1' ]] || round_ops_die "signaling must remain a single replica"

printf 'ROUND Linux preflight passed for immutable images, host clock, disk, Compose, and TURN TLS.\n'
