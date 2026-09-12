#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=ops/linux/common.sh
source "$script_dir/common.sh"

usage() {
  cat <<'EOF'
Usage: ops/linux/preflight.sh [OPTIONS] ENV_FILE

Options:
  --compose-file FILE   Render this private Compose snapshot.
  --release-file FILE   Validate and render the immutable images saved in FILE.
  --state-dir DIR       Include the release-state filesystem in disk checks.

Read-only production-host gate for ROUND. It validates Linux/Docker readiness,
the private env file, immutable image references, Compose interpolation, clock
synchronization, free disk, and the Cloudflare TURN provider boundary.
EOF
}

release_file=
compose_file=
state_dir=/var/lib/round/releases
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release-file)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit 2
      }
      release_file=$2
      shift 2
      ;;
    --compose-file)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit 2
      }
      compose_file=$2
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
env_file=$1
repo_root=$(round_ops_repo_root)
cd "$repo_root"
if [[ -z "$compose_file" ]]; then
  compose_file="$repo_root/compose.yml"
else
  [[ -n "$release_file" ]] ||
    round_ops_die "--compose-file requires --release-file"
  round_ops_require_private_file "$compose_file"
fi

[[ "$(uname -s)" == 'Linux' ]] || round_ops_die "production preflight must run on Linux"
for command_name in df docker jq openssl realpath timedatectl; do
  round_ops_require_command "$command_name"
done
round_ops_require_private_file "$env_file"
[[ "$state_dir" == /* ]] || round_ops_die "release state directory must be absolute"
round_ops_require_private_directory "$state_dir"
if [[ -n "$release_file" ]]; then
  round_ops_assert_state_compatible "$release_file" "$env_file" "$compose_file"
  edge_image=$(round_ops_read_env_value "$release_file" ROUND_EDGE_IMAGE)
  signaling_image=$(round_ops_read_env_value "$release_file" ROUND_SIGNALING_IMAGE)
  source_commit=$(round_ops_read_env_value "$release_file" ROUND_CHECKOUT_COMMIT)
  round_ops_verify_signed_provenance \
    "$source_commit" "$edge_image" "$signaling_image"
else
  edge_image=$(round_ops_read_env_value "$env_file" ROUND_EDGE_IMAGE)
  signaling_image=$(round_ops_read_env_value "$env_file" ROUND_SIGNALING_IMAGE)
  round_ops_require_image_repository ROUND_EDGE_IMAGE "$edge_image" edge
  round_ops_require_image_repository ROUND_SIGNALING_IMAGE "$signaling_image" signaling
fi
round_ops_require_compose_version

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

round_domain=$(round_ops_read_env_value "$env_file" ROUND_DOMAIN)
allowed_origins=$(round_ops_read_env_value "$env_file" ALLOWED_ORIGINS)
ice_transport_policy=$(round_ops_read_env_value "$env_file" VITE_ICE_TRANSPORT_POLICY)
turn_provider=$(round_ops_read_env_value "$env_file" TURN_PROVIDER)
turn_key_id=$(round_ops_read_env_value "$env_file" TURN_CLOUDFLARE_KEY_ID)
turn_api_token=$(round_ops_read_env_value "$env_file" TURN_CLOUDFLARE_API_TOKEN)
compose_profiles=$(round_ops_read_env_value "$env_file" COMPOSE_PROFILES)
access_password_hash=$(round_ops_read_env_value "$env_file" ROUND_ACCESS_PASSWORD_HASH)
[[ "$allowed_origins" == "https://$round_domain" ]] ||
  round_ops_die "ALLOWED_ORIGINS must equal the exact ROUND_DOMAIN HTTPS origin"
[[ "$ice_transport_policy" == all || "$ice_transport_policy" == relay ]] ||
  round_ops_die "VITE_ICE_TRANSPORT_POLICY must be all or relay"
[[ "$round_domain" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$ && \
   "$round_domain" == *.* && "$round_domain" != *..* && \
   "$round_domain" != *.-* && "$round_domain" != *-.* ]] ||
  round_ops_die "invalid deployment hostname: $round_domain"
[[ "$turn_provider" == cloudflare ]] ||
  round_ops_die "TURN_PROVIDER must be cloudflare in production"
[[ -n "$turn_key_id" && -n "$turn_api_token" ]] ||
  round_ops_die "Cloudflare TURN key ID and API token must be configured"
case "$compose_profiles" in
  none) ;;
  observability)
    grafana_prometheus_url=$(
      round_ops_read_env_value "$env_file" GRAFANA_CLOUD_PROMETHEUS_URL
    )
    round_ops_read_env_value "$env_file" GRAFANA_CLOUD_PROMETHEUS_USER >/dev/null
    round_ops_read_env_value "$env_file" GRAFANA_CLOUD_API_TOKEN >/dev/null
    [[ "$grafana_prometheus_url" == https://* ]] ||
      round_ops_die "GRAFANA_CLOUD_PROMETHEUS_URL must use HTTPS"
    ;;
  *) round_ops_die "COMPOSE_PROFILES must be none or observability" ;;
esac
[[ "$access_password_hash" =~ ^\'\$2[ab]\$12\$[./A-Za-z0-9]{53}\'$ ]] ||
  round_ops_die "ROUND_ACCESS_PASSWORD_HASH must be a single-quoted bcrypt cost-12 hash"

compose_config=$(
  round_ops_compose_with_file \
    "$compose_file" "$env_file" "$edge_image" "$signaling_image" \
    config --format json
)
replicas=$(jq -er '.services.signaling.deploy.replicas' <<<"$compose_config")
[[ "$replicas" == '1' ]] || round_ops_die "signaling must remain a single replica"
if [[ "$compose_profiles" == observability ]]; then
  jq -e '.services.alloy.image
    | test("^grafana/alloy:[^@[:space:]]+@sha256:[0-9a-f]{64}$")' \
    <<<"$compose_config" >/dev/null ||
    round_ops_die "Alloy 이미지는 grafana/alloy의 태그와 SHA-256 digest로 고정해야 합니다"
fi

printf 'ROUND Linux preflight passed for immutable images, host clock, disk, Compose, Cloudflare TURN, and optional Grafana Cloud.\n'
