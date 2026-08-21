#!/usr/bin/env bash

# Shared, source-only helpers for the Linux deployment commands. Keep this file
# free of side effects so validation tests can exercise each boundary without
# touching a real Compose project.

round_ops_error() {
  printf 'round linux ops: %s\n' "$*" >&2
}

round_ops_die() {
  round_ops_error "$*"
  exit 1
}

round_ops_repo_root() {
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd
}

round_ops_require_command() {
  command -v "$1" >/dev/null 2>&1 || round_ops_die "missing required command: $1"
}

round_ops_require_clean_checkout() {
  local repo_root
  local untracked

  round_ops_require_command git
  repo_root=$(round_ops_repo_root)
  git -C "$repo_root" diff --quiet --ignore-submodules -- ||
    round_ops_die "tracked ROUND files differ from the checked-out commit"
  git -C "$repo_root" diff --cached --quiet --ignore-submodules -- ||
    round_ops_die "staged ROUND files differ from the checked-out commit"
  untracked=$(git -C "$repo_root" ls-files --others --exclude-standard) ||
    round_ops_die "could not inspect untracked ROUND files"
  [[ -z "$untracked" ]] ||
    round_ops_die "untracked ROUND files exist; deploy only a reviewed clean checkout"
}

round_ops_file_mode() {
  local path=$1
  if stat -c '%a' "$path" 2>/dev/null; then
    return
  fi
  stat -f '%Lp' "$path" 2>/dev/null || round_ops_die "could not inspect permissions for $path"
}

round_ops_file_owner() {
  local path=$1
  if stat -c '%u' "$path" 2>/dev/null; then
    return
  fi
  stat -f '%u' "$path" 2>/dev/null || round_ops_die "could not inspect ownership for $path"
}

round_ops_read_env_value() {
  local env_file=$1
  local key=$2
  local result

  result=$(
    awk -v requested_key="$key" '
      index($0, requested_key "=") == 1 {
        count += 1
        value = substr($0, length(requested_key) + 2)
      }
      END {
        if (count != 1 || value == "") {
          exit 1
        }
        print value
      }
    ' "$env_file"
  ) || round_ops_die "$key must have exactly one non-empty assignment in $env_file"

  case "$result" in
    *$'\n'* | *$'\r'* )
      round_ops_die "$key contains a line break"
      ;;
  esac
  printf '%s\n' "$result"
}

round_ops_require_private_file() {
  local file=$1
  local mode
  local owner

  [[ -f "$file" && ! -L "$file" ]] || round_ops_die "expected a regular file: $file"
  [[ -r "$file" ]] || round_ops_die "file is not readable: $file"
  mode=$(round_ops_file_mode "$file")
  owner=$(round_ops_file_owner "$file")
  [[ "$mode" == '600' ]] || round_ops_die "$file must have mode 0600 (found $mode)"
  [[ "$owner" == "$(id -u)" ]] || round_ops_die "$file must be owned by the invoking user"
}

round_ops_require_private_directory() {
  local directory=$1
  local mode
  local owner

  [[ -d "$directory" && ! -L "$directory" ]] ||
    round_ops_die "expected a private directory: $directory"
  mode=$(round_ops_file_mode "$directory")
  owner=$(round_ops_file_owner "$directory")
  [[ "$mode" == '700' ]] ||
    round_ops_die "$directory must have mode 0700 (found $mode)"
  [[ "$owner" == "$(id -u)" ]] ||
    round_ops_die "$directory must be owned by the invoking user"
}

round_ops_prepare_private_directory() {
  local requested=$1
  local parent
  local basename
  local resolved_parent
  local destination

  [[ "$requested" == /* ]] || round_ops_die "private directory path must be absolute: $requested"
  parent=$(dirname -- "$requested")
  basename=$(basename -- "$requested")
  [[ "$basename" != '.' && "$basename" != '..' && "$basename" != '/' ]] ||
    round_ops_die "refusing a broad private directory target: $requested"
  [[ -d "$parent" && ! -L "$parent" ]] ||
    round_ops_die "private directory parent must already exist: $parent"
  resolved_parent=$(cd -- "$parent" && pwd -P)
  destination="$resolved_parent/$basename"
  case "$destination" in
    / | /var | /var/lib | /var/backups | /tmp | /private/tmp)
      round_ops_die "refusing a broad private directory target: $destination"
      ;;
  esac

  if [[ ! -e "$destination" ]]; then
    umask 077
    mkdir -- "$destination"
    chmod 0700 "$destination"
  fi
  round_ops_require_private_directory "$destination"
  printf '%s\n' "$destination"
}

round_ops_acquire_lifecycle_lock() {
  local state_root=$1
  local nullglob_was_set=false
  local -a stale_snapshots

  round_ops_require_command flock
  round_ops_require_private_directory "$state_root"
  exec 9<"$state_root"
  flock -n 9 || round_ops_die "another ROUND lifecycle operation is already running"
  if shopt -q nullglob; then
    nullglob_was_set=true
  else
    shopt -s nullglob
  fi
  stale_snapshots=("$state_root"/.deploy-snapshot.*)
  if [[ "$nullglob_was_set" != true ]]; then
    shopt -u nullglob
  fi
  (( ${#stale_snapshots[@]} == 0 )) ||
    round_ops_die "a stale deployment snapshot exists; inspect and securely remove ${stale_snapshots[0]} before another lifecycle operation"
}

round_ops_validate_digest_ref() {
  local label=$1
  local image_ref=$2
  [[ "$image_ref" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] ||
    round_ops_die "$label must be an immutable image digest reference"
}

round_ops_expected_image_repository() {
  case "$1" in
    edge) printf '%s\n' 'ghcr.io/ljkhyeong/round-edge' ;;
    signaling) printf '%s\n' 'ghcr.io/ljkhyeong/round-signaling' ;;
    turn) printf '%s\n' 'ghcr.io/ljkhyeong/round-turn' ;;
    *) round_ops_die "unknown ROUND image role: $1" ;;
  esac
}

round_ops_require_image_repository() {
  local label=$1
  local image_ref=$2
  local role=$3
  local actual_repository
  local expected_repository

  round_ops_validate_digest_ref "$label" "$image_ref"
  actual_repository=${image_ref%@sha256:*}
  expected_repository=$(round_ops_expected_image_repository "$role")
  [[ "$actual_repository" == "$expected_repository" ]] ||
    round_ops_die "$label must use the reviewed repository $expected_repository"
}

round_ops_verify_signed_provenance() {
  local source_commit=$1
  shift
  local repository
  local signer_workflow
  local image_ref

  round_ops_require_command gh
  repository='ljkhyeong/webrtc-study'
  signer_workflow="$repository/.github/workflows/release-images.yml"
  for image_ref in "$@"; do
    gh attestation verify "oci://$image_ref" \
      --hostname github.com \
      --repo "$repository" \
      --signer-workflow "$signer_workflow" \
      --source-digest "$source_commit" \
      --bundle-from-oci \
      --deny-self-hosted-runners \
      >/dev/null ||
      round_ops_die "could not verify signed build provenance for $image_ref"
  done
}

round_ops_inspect_image_labels() {
  local image_ref=$1
  local labels
  local label_fields

  labels=$(round_ops_docker image inspect --format '{{json .Config.Labels}}' "$image_ref") ||
    round_ops_die "could not inspect image labels on $image_ref"
  label_fields=$(jq -er '
    def required($label):
      .[$label]
      | select(type == "string" and length > 0 and (test("[\\r\\n\\t]") | not));
    select(type == "object")
    | [
        required("org.opencontainers.image.version"),
        required("io.round.release.tag-object"),
        required("io.round.image.role"),
        required("io.round.image.flavor")
      ]
    | @tsv
  ' <<<"$labels") ||
    round_ops_die "$image_ref has incomplete or invalid release identity labels"
  printf '%s\n' "$label_fields"
}

round_ops_verify_release_image_labels() {
  local release_file=$1
  local env_file=$2
  local edge_image
  local signaling_image
  local turn_image
  local ice_transport_policy
  local expected_edge_flavor
  local edge_labels
  local signaling_labels
  local turn_labels
  local edge_version
  local signaling_version
  local turn_version
  local normalized_edge_version
  local edge_tag_object
  local signaling_tag_object
  local turn_tag_object
  local edge_role
  local signaling_role
  local turn_role
  local edge_flavor
  local signaling_flavor
  local turn_flavor

  round_ops_require_command jq
  edge_image=$(round_ops_read_env_value "$release_file" ROUND_EDGE_IMAGE)
  signaling_image=$(round_ops_read_env_value "$release_file" ROUND_SIGNALING_IMAGE)
  turn_image=$(round_ops_read_env_value "$release_file" ROUND_TURN_IMAGE)

  ice_transport_policy=$(round_ops_read_env_value "$env_file" VITE_ICE_TRANSPORT_POLICY)
  case "$ice_transport_policy" in
    all) expected_edge_flavor=standalone ;;
    relay) expected_edge_flavor=relay ;;
    *) round_ops_die "VITE_ICE_TRANSPORT_POLICY must be all or relay" ;;
  esac

  edge_labels=$(round_ops_inspect_image_labels "$edge_image")
  signaling_labels=$(round_ops_inspect_image_labels "$signaling_image")
  turn_labels=$(round_ops_inspect_image_labels "$turn_image")
  IFS=$'\t' read -r \
    edge_version edge_tag_object edge_role edge_flavor \
    <<<"$edge_labels"
  IFS=$'\t' read -r \
    signaling_version signaling_tag_object signaling_role signaling_flavor \
    <<<"$signaling_labels"
  IFS=$'\t' read -r \
    turn_version turn_tag_object turn_role turn_flavor \
    <<<"$turn_labels"

  [[ "$edge_role" == edge ]] || round_ops_die "ROUND_EDGE_IMAGE does not carry the edge role"
  [[ "$signaling_role" == signaling ]] ||
    round_ops_die "ROUND_SIGNALING_IMAGE does not carry the signaling role"
  [[ "$turn_role" == turn ]] || round_ops_die "ROUND_TURN_IMAGE does not carry the TURN role"

  [[ "$edge_flavor" == "$expected_edge_flavor" ]] ||
    round_ops_die "ROUND_EDGE_IMAGE flavor does not match VITE_ICE_TRANSPORT_POLICY"
  [[ "$signaling_flavor" == shared ]] ||
    round_ops_die "ROUND_SIGNALING_IMAGE does not carry the shared flavor"
  [[ "$turn_flavor" == shared ]] ||
    round_ops_die "ROUND_TURN_IMAGE does not carry the shared flavor"

  normalized_edge_version=$edge_version
  if [[ "$expected_edge_flavor" == relay ]]; then
    [[ "$edge_version" == *-relay ]] ||
      round_ops_die "relay edge image version must end in -relay"
    normalized_edge_version=${edge_version%-relay}
  fi
  [[ "$normalized_edge_version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]] ||
    round_ops_die "release images carry an invalid SemVer image version"
  [[ "$signaling_version" == "$normalized_edge_version" && \
     "$turn_version" == "$normalized_edge_version" ]] ||
    round_ops_die "release image versions do not identify the same release"

  [[ "$edge_tag_object" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] ||
    round_ops_die "release images carry an invalid annotated-tag object"
  [[ "$signaling_tag_object" == "$edge_tag_object" && \
     "$turn_tag_object" == "$edge_tag_object" ]] ||
    round_ops_die "release images do not come from the same annotated tag object"
}

round_ops_create_deployment_snapshot() {
  local state_root=$1
  local env_file=$2
  local compose_file=$3
  local snapshot_dir

  round_ops_require_private_directory "$state_root"
  round_ops_require_private_file "$env_file"
  [[ -f "$compose_file" && ! -L "$compose_file" && -r "$compose_file" ]] ||
    round_ops_die "expected a readable regular Compose file: $compose_file"
  snapshot_dir=$(mktemp -d "$state_root/.deploy-snapshot.XXXXXX") ||
    round_ops_die "could not create a deployment snapshot under $state_root"
  chmod 0700 "$snapshot_dir"
  if ! cp -- "$env_file" "$snapshot_dir/runtime.env" ||
     ! cp -- "$compose_file" "$snapshot_dir/compose.yml" ||
     ! chmod 0600 "$snapshot_dir/runtime.env" "$snapshot_dir/compose.yml"; then
    rm -f -- "$snapshot_dir/runtime.env" "$snapshot_dir/compose.yml"
    rmdir -- "$snapshot_dir" 2>/dev/null || true
    round_ops_die "could not create the private deployment snapshot"
  fi
  round_ops_require_private_directory "$snapshot_dir"
  round_ops_require_private_file "$snapshot_dir/runtime.env"
  round_ops_require_private_file "$snapshot_dir/compose.yml"
  printf '%s\n' "$snapshot_dir"
}

round_ops_remove_deployment_snapshot() {
  local state_root=$1
  local snapshot_dir=$2
  local resolved_state_root
  local resolved_parent
  local snapshot_name

  round_ops_require_private_directory "$state_root"
  [[ -d "$snapshot_dir" && ! -L "$snapshot_dir" ]] ||
    round_ops_die "deployment snapshot is not a regular directory: $snapshot_dir"
  resolved_state_root=$(cd -- "$state_root" && pwd -P)
  resolved_parent=$(cd -- "$(dirname -- "$snapshot_dir")" && pwd -P)
  snapshot_name=$(basename -- "$snapshot_dir")
  [[ "$resolved_parent" == "$resolved_state_root" && \
     "$snapshot_name" == .deploy-snapshot.* ]] ||
    round_ops_die "refusing to remove an unexpected deployment snapshot: $snapshot_dir"
  rm -f -- "$snapshot_dir/runtime.env" "$snapshot_dir/compose.yml"
  rmdir -- "$snapshot_dir" ||
    round_ops_die "deployment snapshot contains unexpected files: $snapshot_dir"
}

round_ops_validate_release_file() {
  local release_file=$1
  local edge_image
  local signaling_image
  local turn_image
  local source_commit
  local compose_sha256
  local env_sha256
  local project_name
  local round_domain
  local docker_host

  round_ops_require_private_file "$release_file"
  edge_image=$(round_ops_read_env_value "$release_file" ROUND_EDGE_IMAGE)
  signaling_image=$(round_ops_read_env_value "$release_file" ROUND_SIGNALING_IMAGE)
  turn_image=$(round_ops_read_env_value "$release_file" ROUND_TURN_IMAGE)
  round_ops_require_image_repository ROUND_EDGE_IMAGE "$edge_image" edge
  round_ops_require_image_repository ROUND_SIGNALING_IMAGE "$signaling_image" signaling
  round_ops_require_image_repository ROUND_TURN_IMAGE "$turn_image" turn
  source_commit=$(round_ops_read_env_value "$release_file" ROUND_CHECKOUT_COMMIT)
  compose_sha256=$(round_ops_read_env_value "$release_file" ROUND_COMPOSE_SHA256)
  env_sha256=$(round_ops_read_env_value "$release_file" ROUND_ENV_SHA256)
  project_name=$(round_ops_read_env_value "$release_file" ROUND_PROJECT_NAME)
  round_domain=$(round_ops_read_env_value "$release_file" ROUND_DOMAIN)
  docker_host=$(round_ops_read_env_value "$release_file" ROUND_DOCKER_HOST)
  [[ "$source_commit" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] ||
    round_ops_die "$release_file contains an invalid source commit"
  [[ "$compose_sha256" =~ ^[0-9a-f]{64}$ ]] ||
    round_ops_die "$release_file contains an invalid Compose digest"
  [[ "$env_sha256" =~ ^[0-9a-f]{64}$ ]] ||
    round_ops_die "$release_file contains an invalid env digest"
  [[ "$project_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]] ||
    round_ops_die "$release_file contains an invalid project name"
  [[ "$round_domain" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$ ]] ||
    round_ops_die "$release_file contains an invalid ROUND domain"
  [[ "$docker_host" == 'unix:///var/run/docker.sock' ]] ||
    round_ops_die "$release_file contains an unsupported Docker endpoint"

  awk '
      /^(ROUND_EDGE_IMAGE|ROUND_SIGNALING_IMAGE|ROUND_TURN_IMAGE|ROUND_CHECKOUT_COMMIT|ROUND_COMPOSE_SHA256|ROUND_ENV_SHA256|ROUND_PROJECT_NAME|ROUND_DOMAIN|ROUND_DOCKER_HOST)=/ {
        next
      }
      NF != 0 { exit 1 }
    ' "$release_file" ||
    round_ops_die "$release_file contains an unexpected release-state entry"
}

round_ops_write_release_file() {
  local destination=$1
  local env_file=$2
  local edge_image=$3
  local signaling_image=$4
  local turn_image=$5
  local compose_file=${6:-}
  local destination_dir
  local temporary
  local repo_root
  local source_commit
  local compose_sha256
  local env_sha256
  local project_name
  local round_domain

  round_ops_require_image_repository ROUND_EDGE_IMAGE "$edge_image" edge
  round_ops_require_image_repository ROUND_SIGNALING_IMAGE "$signaling_image" signaling
  round_ops_require_image_repository ROUND_TURN_IMAGE "$turn_image" turn
  round_ops_require_private_file "$env_file"
  repo_root=$(round_ops_repo_root)
  if [[ -z "$compose_file" ]]; then
    compose_file="$repo_root/compose.yml"
  fi
  [[ -f "$compose_file" && ! -L "$compose_file" && -r "$compose_file" ]] ||
    round_ops_die "expected a readable regular Compose file: $compose_file"
  source_commit=$(git -C "$repo_root" rev-parse HEAD) ||
    round_ops_die "could not resolve the ROUND source commit"
  compose_sha256=$(round_ops_sha256_file "$compose_file")
  env_sha256=$(round_ops_runtime_env_sha256 "$env_file")
  project_name=$(round_ops_read_env_value "$env_file" COMPOSE_PROJECT_NAME)
  round_domain=$(round_ops_read_env_value "$env_file" ROUND_DOMAIN)
  destination_dir=$(dirname -- "$destination")
  round_ops_require_private_directory "$destination_dir"
  temporary=$(mktemp "$destination_dir/.round-release.XXXXXX")
  chmod 0600 "$temporary"
  {
    printf 'ROUND_EDGE_IMAGE=%s\n' "$edge_image"
    printf 'ROUND_SIGNALING_IMAGE=%s\n' "$signaling_image"
    printf 'ROUND_TURN_IMAGE=%s\n' "$turn_image"
    printf 'ROUND_CHECKOUT_COMMIT=%s\n' "$source_commit"
    printf 'ROUND_COMPOSE_SHA256=%s\n' "$compose_sha256"
    printf 'ROUND_ENV_SHA256=%s\n' "$env_sha256"
    printf 'ROUND_PROJECT_NAME=%s\n' "$project_name"
    printf 'ROUND_DOMAIN=%s\n' "$round_domain"
    printf 'ROUND_DOCKER_HOST=unix:///var/run/docker.sock\n'
  } >"$temporary"
  mv -f -- "$temporary" "$destination"
}

round_ops_copy_release_file() {
  local source=$1
  local destination=$2
  local destination_dir
  local temporary

  round_ops_validate_release_file "$source"
  destination_dir=$(dirname -- "$destination")
  round_ops_require_private_directory "$destination_dir"
  temporary=$(mktemp "$destination_dir/.round-release-copy.XXXXXX")
  chmod 0600 "$temporary"
  cp -- "$source" "$temporary"
  mv -f -- "$temporary" "$destination"
}

round_ops_sha256_file() {
  local file=$1
  local digest
  digest=$(openssl dgst -sha256 "$file" | awk '{ print $NF }') ||
    round_ops_die "could not hash $file"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || round_ops_die "invalid SHA-256 output for $file"
  printf '%s\n' "$digest"
}

round_ops_runtime_env_sha256() {
  local env_file=$1
  local digest

  round_ops_require_private_file "$env_file"
  digest=$(
    awk '
      !/^(ROUND_EDGE_IMAGE|ROUND_SIGNALING_IMAGE|ROUND_TURN_IMAGE)=/ { print }
    ' "$env_file" |
      openssl dgst -sha256 |
      awk '{ print $NF }'
  ) || round_ops_die "could not hash the runtime config in $env_file"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] ||
    round_ops_die "invalid runtime-config SHA-256 output for $env_file"
  printf '%s\n' "$digest"
}

round_ops_assert_state_compatible() {
  local release_file=$1
  local env_file=$2
  local compose_file=${3:-}
  local repo_root
  local expected
  local actual

  round_ops_validate_release_file "$release_file"
  round_ops_require_private_file "$env_file"
  repo_root=$(round_ops_repo_root)
  if [[ -z "$compose_file" ]]; then
    compose_file="$repo_root/compose.yml"
  fi
  [[ -f "$compose_file" && ! -L "$compose_file" && -r "$compose_file" ]] ||
    round_ops_die "expected a readable regular Compose file: $compose_file"
  expected=$(round_ops_read_env_value "$release_file" ROUND_COMPOSE_SHA256)
  actual=$(round_ops_sha256_file "$compose_file")
  [[ "$actual" == "$expected" ]] ||
    round_ops_die "Compose config differs from the saved deployment state; restore its reviewed checkout first"
  expected=$(round_ops_read_env_value "$release_file" ROUND_ENV_SHA256)
  actual=$(round_ops_runtime_env_sha256 "$env_file")
  [[ "$actual" == "$expected" ]] ||
    round_ops_die "runtime env differs from the saved deployment state; restore its secret-manager version first"
}

round_ops_require_stable_release_state() {
  local state_dir=$1
  local marker

  round_ops_require_private_directory "$state_dir"
  for marker in \
    pending.env \
    in-progress.env \
    rollback-pending.env \
    rollback-in-progress.env \
    rollback-origin.env; do
    [[ ! -e "$state_dir/$marker" ]] ||
      round_ops_die "release lifecycle is not stable; recover $state_dir/$marker first"
  done
}

round_ops_resolve_repo_path() {
  local repo_root=$1
  local configured_path=$2
  case "$configured_path" in
    /*) printf '%s\n' "$configured_path" ;;
    *) printf '%s/%s\n' "$repo_root" "${configured_path#./}" ;;
  esac
}

round_ops_validate_certificate() {
  local env_file=$1
  local minimum_validity_seconds=${2:-1209600}
  local repo_root
  local cert_file
  local key_file
  local turn_realm
  local cert_public_key
  local private_public_key
  local resolved_key_file
  local key_mode
  local key_owner

  round_ops_require_command realpath
  repo_root=$(round_ops_repo_root)
  cert_file=$(round_ops_resolve_repo_path \
    "$repo_root" \
    "$(round_ops_read_env_value "$env_file" TURN_TLS_CERT_FILE)")
  key_file=$(round_ops_resolve_repo_path \
    "$repo_root" \
    "$(round_ops_read_env_value "$env_file" TURN_TLS_KEY_FILE)")
  turn_realm=$(round_ops_read_env_value "$env_file" TURN_REALM)

  [[ -r "$cert_file" && -f "$cert_file" ]] ||
    round_ops_die "TURN certificate is not a readable regular file: $cert_file"
  [[ -r "$key_file" && -f "$key_file" ]] ||
    round_ops_die "TURN private key is not a readable regular file: $key_file"
  resolved_key_file=$(realpath "$key_file") ||
    round_ops_die "could not resolve the TURN private key path"
  key_mode=$(round_ops_file_mode "$resolved_key_file")
  key_owner=$(round_ops_file_owner "$resolved_key_file")
  [[ "$key_mode" == '400' || "$key_mode" == '600' ]] ||
    round_ops_die "TURN private key must have mode 0400 or 0600 (found $key_mode)"
  [[ "$key_owner" == "$(id -u)" ]] ||
    round_ops_die "TURN private key must be owned by the invoking user"
  [[ "$minimum_validity_seconds" =~ ^[0-9]+$ ]] ||
    round_ops_die "minimum certificate validity must be seconds"

  openssl x509 -in "$cert_file" -noout -checkend "$minimum_validity_seconds" >/dev/null ||
    round_ops_die "TURN certificate expires within $minimum_validity_seconds seconds"
  openssl x509 -in "$cert_file" -noout -checkhost "$turn_realm" >/dev/null ||
    round_ops_die "TURN certificate does not cover $turn_realm"

  cert_public_key=$(
    openssl x509 -in "$cert_file" -pubkey -noout |
      openssl pkey -pubin -outform DER 2>/dev/null |
      openssl dgst -sha256
  ) || round_ops_die "could not read the TURN certificate public key"
  private_public_key=$(
    openssl pkey -in "$key_file" -pubout -outform DER 2>/dev/null |
      openssl dgst -sha256
  ) || round_ops_die "could not read the TURN private key"
  [[ "$cert_public_key" == "$private_public_key" ]] ||
    round_ops_die "TURN certificate and private key do not match"
}

round_ops_turn_certificate_fingerprint() {
  local env_file=$1
  local repo_root
  local cert_file
  local fingerprint

  round_ops_require_command cut
  repo_root=$(round_ops_repo_root)
  cert_file=$(round_ops_resolve_repo_path \
    "$repo_root" \
    "$(round_ops_read_env_value "$env_file" TURN_TLS_CERT_FILE)")
  fingerprint=$(openssl x509 -in "$cert_file" -noout -fingerprint -sha256 | cut -d= -f2) ||
    round_ops_die "could not calculate the TURN certificate fingerprint"
  [[ "$fingerprint" =~ ^([0-9A-F]{2}:){31}[0-9A-F]{2}$ ]] ||
    round_ops_die "TURN certificate returned a malformed fingerprint"
  printf '%s\n' "$fingerprint"
}

round_ops_verify_turn_tls_listener() {
  local env_file=$1
  local check_host=${2:-127.0.0.1}
  local check_port=${3:-5349}
  local ca_file=${4:-}
  local turn_realm
  local expected_fingerprint
  local served_fingerprint
  local peer_output
  local -a client_command

  round_ops_require_command openssl
  round_ops_require_command timeout
  [[ "$check_host" =~ ^[A-Za-z0-9.-]+$ ]] ||
    round_ops_die "TURN TLS check host must be an IPv4 address or DNS hostname"
  [[ "$check_port" =~ ^[1-9][0-9]*$ ]] && (( check_port <= 65535 )) ||
    round_ops_die "TURN TLS check port must be between 1 and 65535"
  if [[ -n "$ca_file" ]]; then
    [[ -f "$ca_file" && ! -L "$ca_file" && -r "$ca_file" ]] ||
      round_ops_die "TURN TLS check CA must be a readable regular file: $ca_file"
  fi

  turn_realm=$(round_ops_read_env_value "$env_file" TURN_REALM)
  expected_fingerprint=$(round_ops_turn_certificate_fingerprint "$env_file")
  peer_output=$(mktemp)
  chmod 0600 "$peer_output"
  client_command=(
    openssl s_client
    -connect "$check_host:$check_port"
    -servername "$turn_realm"
    -verify_hostname "$turn_realm"
    -verify_return_error
    -showcerts
  )
  if [[ -n "$ca_file" ]]; then
    client_command+=(-CAfile "$ca_file")
  fi
  if ! timeout 15s "${client_command[@]}" \
    </dev/null \
    >"$peer_output" 2>/dev/null; then
    rm -f -- "$peer_output"
    round_ops_die "coturn TLS listener did not present a trusted certificate for $turn_realm"
  fi
  served_fingerprint=$(
    openssl x509 -in "$peer_output" -noout -fingerprint -sha256 | cut -d= -f2
  ) || {
    rm -f -- "$peer_output"
    round_ops_die "could not read the certificate served by coturn"
  }
  rm -f -- "$peer_output"
  [[ "$served_fingerprint" == "$expected_fingerprint" ]] ||
    round_ops_die "coturn is not serving the configured TURN certificate"
  printf '%s\n' "$expected_fingerprint"
}

round_ops_require_compose_version() {
  local minimum_version=2.24.4
  local version
  local major
  local minor
  local patch

  version=$(round_ops_docker compose version --short 2>/dev/null) ||
    round_ops_die "Docker Compose is unavailable"
  version=${version#v}
  [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]] ||
    round_ops_die "could not parse Docker Compose version: $version"
  major=${BASH_REMATCH[1]}
  minor=${BASH_REMATCH[2]}
  patch=${BASH_REMATCH[3]}
  if (( major < 2 || (major == 2 && minor < 24) || (major == 2 && minor == 24 && patch < 4) )); then
    round_ops_die "Docker Compose $minimum_version or later is required (found $version)"
  fi
}

round_ops_docker() {
  local home_value=${HOME-}
  local -a sanitized=(
    env -i
    "PATH=$PATH"
    'DOCKER_HOST=unix:///var/run/docker.sock'
  )

  if [[ -n "$home_value" ]]; then
    sanitized+=("HOME=$home_value")
  fi
  "${sanitized[@]}" docker "$@"
}

round_ops_compose_with_file() {
  local compose_file=$1
  local env_file=$2
  local edge_image=$3
  local signaling_image=$4
  local turn_image=$5
  shift 5
  local repo_root
  local absolute_compose_file
  local absolute_env_file
  local project_name
  local home_value=${HOME-}
  local -a sanitized=(
    env -i
    "PATH=$PATH"
    'DOCKER_HOST=unix:///var/run/docker.sock'
  )

  repo_root=$(round_ops_repo_root)
  [[ -f "$compose_file" && ! -L "$compose_file" && -r "$compose_file" ]] ||
    round_ops_die "expected a readable regular Compose file: $compose_file"
  absolute_compose_file=$(realpath "$compose_file") ||
    round_ops_die "could not resolve $compose_file"
  absolute_env_file=$(realpath "$env_file") || round_ops_die "could not resolve $env_file"
  project_name=$(round_ops_read_env_value "$absolute_env_file" COMPOSE_PROJECT_NAME)
  [[ "$project_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]] ||
    round_ops_die "COMPOSE_PROJECT_NAME is invalid: $project_name"
  round_ops_validate_digest_ref ROUND_EDGE_IMAGE "$edge_image"
  round_ops_validate_digest_ref ROUND_SIGNALING_IMAGE "$signaling_image"
  round_ops_validate_digest_ref ROUND_TURN_IMAGE "$turn_image"
  if [[ -n "$home_value" ]]; then
    sanitized+=("HOME=$home_value")
  fi

  "${sanitized[@]}" \
    "ROUND_EDGE_IMAGE=$edge_image" \
    "ROUND_SIGNALING_IMAGE=$signaling_image" \
    "ROUND_TURN_IMAGE=$turn_image" \
    docker compose \
      --project-directory "$repo_root" \
      --file "$absolute_compose_file" \
      --project-name "$project_name" \
      --env-file "$absolute_env_file" \
      "$@"
}

round_ops_compose() {
  local env_file=$1
  local edge_image=$2
  local signaling_image=$3
  local turn_image=$4
  shift 4
  local repo_root

  repo_root=$(round_ops_repo_root)
  round_ops_compose_with_file \
    "$repo_root/compose.yml" \
    "$env_file" \
    "$edge_image" \
    "$signaling_image" \
    "$turn_image" \
    "$@"
}

round_ops_compose_volume_name() {
  local env_file=$1
  local edge_image=$2
  local signaling_image=$3
  local turn_image=$4
  local logical_name=$5
  round_ops_compose \
    "$env_file" \
    "$edge_image" \
    "$signaling_image" \
    "$turn_image" \
    config --format json |
    jq -er --arg logical_name "$logical_name" '.volumes[$logical_name].name'
}

round_ops_compose_project_name() {
  local env_file=$1
  local edge_image=$2
  local signaling_image=$3
  local turn_image=$4
  round_ops_compose \
    "$env_file" \
    "$edge_image" \
    "$signaling_image" \
    "$turn_image" \
    config --format json |
    jq -er '.name'
}
