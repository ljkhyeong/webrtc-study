#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"
# shellcheck source=ops/linux/common.sh
source ops/linux/common.sh

fail() {
  printf 'linux ops test: %s\n' "$*" >&2
  exit 1
}

fixture_dir=$(mktemp -d)
cleanup() {
  rm -rf -- "$fixture_dir"
}
trap cleanup EXIT
umask 077

digest_a=$(printf 'a%.0s' {1..64})
digest_b=$(printf 'b%.0s' {1..64})
digest_d=$(printf 'd%.0s' {1..64})
digest_e=$(printf 'e%.0s' {1..64})

write_env() {
  local destination=$1
  local edge_digest=$2
  local signaling_digest=$3
  local ice_transport_policy=${4:-all}
  local image_namespace=${5:-ghcr.io/ljkhyeong}
  local turn_provider=${6:-cloudflare}
  local compose_profiles=${7:-none}
  cat >"$destination" <<EOF
COMPOSE_PROJECT_NAME=round-linux-test
COMPOSE_PROFILES=$compose_profiles
ROUND_EDGE_IMAGE=$image_namespace/round-edge@sha256:$edge_digest
ROUND_SIGNALING_IMAGE=$image_namespace/round-signaling@sha256:$signaling_digest
GRAFANA_ALLOY_IMAGE=grafana/alloy:v1.18.1@sha256:0f4434c92b3e6cdac38bb129b344e1790c246f7b6e2eaffcc16a5fa363240e33
GRAFANA_CLOUD_PROMETHEUS_URL=https://prometheus.example.invalid/api/prom/push
GRAFANA_CLOUD_PROMETHEUS_USER=12345
GRAFANA_CLOUD_API_TOKEN=test-token
ROUND_DOMAIN=round.round.invalid
ALLOWED_ORIGINS=https://round.round.invalid
VITE_ICE_TRANSPORT_POLICY=$ice_transport_policy
TURN_PROVIDER=$turn_provider
TURN_CLOUDFLARE_KEY_ID=test-key-id
TURN_CLOUDFLARE_API_TOKEN=test-api-token
ROUND_ACCESS_PASSWORD_HASH='\$2a\$12\$RJKd/exBEqUGjd.mtH9URu8H/TGJgwahZV8tA.xhPCM/4rdHfpmYS'
EOF
  chmod 0600 "$destination"
}

env_a="$fixture_dir/production-a.env"
env_b="$fixture_dir/production-b.env"
env_bad_provider="$fixture_dir/production-bad-provider.env"
write_env "$env_a" "$digest_a" "$digest_b"
write_env "$env_b" "$digest_d" "$digest_e"
write_env \
  "$env_bad_provider" \
  "$digest_a" \
  "$digest_b" \
  all \
  ghcr.io/ljkhyeong \
  disabled

round_ops_require_private_file "$env_a"
round_ops_validate_digest_ref \
  ROUND_EDGE_IMAGE \
  "ghcr.io/ljkhyeong/round-edge@sha256:$digest_a"
if (round_ops_validate_digest_ref ROUND_EDGE_IMAGE 'registry.invalid/round-edge:latest' 2>/dev/null); then
  fail 'mutable image tag was accepted'
fi
if (round_ops_require_image_repository \
  ROUND_EDGE_IMAGE \
  "ghcr.io/attacker/round-edge@sha256:$digest_a" \
  edge 2>/dev/null); then
  fail 'an unreviewed edge image repository was accepted'
fi
if (round_ops_prepare_private_directory /var >/dev/null 2>&1); then
  fail 'broad private directory target was accepted'
fi

release_file="$fixture_dir/release.env"
round_ops_write_release_file \
  "$release_file" \
  "$env_a" \
  "ghcr.io/ljkhyeong/round-edge@sha256:$digest_a" \
  "ghcr.io/ljkhyeong/round-signaling@sha256:$digest_b"
round_ops_validate_release_file "$release_file"

snapshot_source_env="$fixture_dir/snapshot-source.env"
snapshot_source_compose="$fixture_dir/snapshot-source-compose.yml"
cp -- "$env_a" "$snapshot_source_env"
cp -- compose.yml "$snapshot_source_compose"
chmod 0600 "$snapshot_source_env" "$snapshot_source_compose"
snapshot_root="$fixture_dir/snapshot-root"
mkdir "$snapshot_root"
chmod 0700 "$snapshot_root"
snapshot_dir=$(round_ops_create_deployment_snapshot \
  "$snapshot_root" \
  "$snapshot_source_env" \
  "$snapshot_source_compose")
[[ "$(round_ops_file_mode "$snapshot_dir")" == '700' ]] ||
  fail 'deployment snapshot directory was not private'
[[ "$(round_ops_file_mode "$snapshot_dir/runtime.env")" == '600' ]] ||
  fail 'deployment env snapshot was not mode 0600'
[[ "$(round_ops_file_mode "$snapshot_dir/compose.yml")" == '600' ]] ||
  fail 'deployment Compose snapshot was not mode 0600'
printf 'ROUND_DOMAIN=changed.invalid\n' >>"$snapshot_source_env"
printf '\n# changed source\n' >>"$snapshot_source_compose"
if cmp -s -- "$snapshot_source_env" "$snapshot_dir/runtime.env"; then
  fail 'deployment env snapshot followed a later source mutation'
fi
if cmp -s -- "$snapshot_source_compose" "$snapshot_dir/compose.yml"; then
  fail 'deployment Compose snapshot followed a later source mutation'
fi
round_ops_remove_deployment_snapshot "$snapshot_root" "$snapshot_dir"
[[ ! -e "$snapshot_dir" ]] || fail 'deployment snapshot cleanup left state behind'

fake_bin="$fixture_dir/bin"
fake_docker_root="$fixture_dir/docker-root"
mkdir -p "$fake_bin" "$fake_docker_root"
cat >"$fake_bin/uname" <<'EOF'
#!/usr/bin/env bash
printf 'Linux\n'
EOF
cat >"$fake_bin/timedatectl" <<'EOF'
#!/usr/bin/env bash
printf 'yes\n'
EOF
cat >"$fake_bin/df" <<'EOF'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf '/dev/test 20971520 1 20971519 1%% /\n'
EOF
cat >"$fake_bin/flock" <<'EOF'
#!/usr/bin/env bash
fake_root=$(cd -- "$(dirname -- "$0")/.." && pwd)
[[ ! -e "$fake_root/flock-fail" ]]
EOF
cat >"$fake_bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
fake_root=$(cd -- "$(dirname -- "$0")/.." && pwd)
case " $* " in
  *' rev-parse HEAD '*) printf '0123456789abcdef0123456789abcdef01234567\n' ;;
  *' status --porcelain=v1 --untracked-files=all --ignore-submodules=all '*)
    if [[ -e "$fake_root/git-dirty" ]]; then
      printf ' M tracked-file\n'
    fi
    ;;
  *)
    printf 'unexpected fake git invocation: %s\n' "$*" >&2
    exit 1
    ;;
esac
EOF
cat >"$fake_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
fake_root=$(cd -- "$(dirname -- "$0")/.." && pwd)
[[ "${1:-}" == attestation && "${2:-}" == verify && "${3:-}" == oci://* ]] || exit 1
image_ref=${3#oci://}
shift 3
hostname=
repository=
signer_workflow=
source_digest=
bundle_from_oci=false
deny_self_hosted=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hostname) hostname=$2; shift 2 ;;
    --repo) repository=$2; shift 2 ;;
    --signer-workflow) signer_workflow=$2; shift 2 ;;
    --source-digest) source_digest=$2; shift 2 ;;
    --bundle-from-oci) bundle_from_oci=true; shift ;;
    --deny-self-hosted-runners) deny_self_hosted=true; shift ;;
    *) exit 1 ;;
  esac
done
[[ "$hostname" == github.com ]]
[[ "$repository" == ljkhyeong/webrtc-study ]]
[[ "$signer_workflow" == \
  ljkhyeong/webrtc-study/.github/workflows/release-images.yml ]]
[[ "$source_digest" == 0123456789abcdef0123456789abcdef01234567 ]]
[[ "$bundle_from_oci" == true && "$deny_self_hosted" == true ]]
[[ "$image_ref" =~ ^ghcr\.io/ljkhyeong/round-(edge|signaling)@sha256:[0-9a-f]{64}$ ]]
printf 'attestation-verify %s\n' "$image_ref" >>"$fake_root/gh.log"
if [[ -f "$fake_root/fail-provenance-reference" && \
      "$image_ref" == "$(cat "$fake_root/fail-provenance-reference")" ]]; then
  exit 1
fi
[[ ! -e "$fake_root/fail-provenance" ]]
EOF
cat >"$fake_bin/age" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
fake_root=$(cd -- "$(dirname -- "$0")/.." && pwd)
if [[ " $* " == *' --decrypt '* ]]; then
  input_file=${@: -1}
  printf 'decrypt %s\n' "$input_file" >>"$fake_root/age.log"
  if [[ -s "$fake_root/mutate-backup-after-decrypt" ]]; then
    original_backup=$(<"$fake_root/mutate-backup-after-decrypt")
    printf 'changed external backup\n' >"$original_backup"
    rm -f -- "$fake_root/mutate-backup-after-decrypt"
  fi
  cat "$input_file"
  exit 0
fi
output=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      output=$2
      shift 2
      ;;
    *) shift ;;
  esac
done
if [[ -n "$output" ]]; then
  cat >"$output"
else
  cat
fi
EOF
cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
fake_root=$(cd -- "$(dirname -- "$0")/.." && pwd)
command_line=" $* "
log_compose() {
  printf 'args=%s edge=%s signaling=%s compose_file=%s compose_project=%s node_image=%s docker_host=%s docker_context=%s\n' \
    "$*" \
    "${ROUND_EDGE_IMAGE-unset}" \
    "${ROUND_SIGNALING_IMAGE-unset}" \
    "${COMPOSE_FILE-unset}" \
    "${COMPOSE_PROJECT_NAME-unset}" \
    "${NODE_IMAGE-unset}" \
    "${DOCKER_HOST-unset}" \
    "${DOCKER_CONTEXT-unset}" \
    >>"$fake_root/docker.log"
}
case "$command_line" in
  *' compose version --short '*) printf '2.24.4\n' ;;
  *" info --format {{.DockerRootDir}} "*) printf '%s/docker-root\n' "$fake_root" ;;
  *' info '*) true ;;
  *' image inspect --format '*)
    template=$4
    image_ref=$5
    [[ "$template" == '{{json .Config.Labels}}' ]] || exit 1
    printf 'image-inspect %s\n' "$image_ref" >>"$fake_root/docker.log"
    source_label=https://github.com/ljkhyeong/webrtc-study
    revision_label=0123456789abcdef0123456789abcdef01234567
    version_label=v1.2.3
    tag_object_label=1234567890abcdef1234567890abcdef12345678
    case "$image_ref" in
      *'/round-edge@'*)
        role_label=edge
        flavor_label=standalone
        if [[ -e "$fake_root/wrong-edge-role" ]]; then role_label=turn; fi
        if [[ -e "$fake_root/edge-flavor-relay" ]]; then
          flavor_label=relay
          version_label=v1.2.3-relay
        fi
        ;;
      *'/round-signaling@'*)
        role_label=signaling
        flavor_label=shared
        if [[ -e "$fake_root/mixed-release" ]]; then
          tag_object_label=fedcba9876543210fedcba9876543210fedcba98
        fi
        ;;
      *) exit 1 ;;
    esac
    if [[ "$image_ref" == *'/round-edge@'* && \
       -e "$fake_root/omit-edge-release-metadata" ]]; then
      printf '{"io.round.image.role":"%s","io.round.image.flavor":"%s"}\n' \
        "$role_label" "$flavor_label"
    else
      printf '{"org.opencontainers.image.source":"%s","org.opencontainers.image.revision":"%s","org.opencontainers.image.version":"%s","io.round.release.tag-object":"%s","io.round.image.role":"%s","io.round.image.flavor":"%s"}\n' \
        "$source_label" "$revision_label" "$version_label" "$tag_object_label" \
        "$role_label" "$flavor_label"
    fi
    ;;
  *' config --format json '*)
    log_compose "$@"
    if [[ -s "$fake_root/mutate-original-env-after-config" ]]; then
      original_env=$(cat "$fake_root/mutate-original-env-after-config")
      printf '\nMAX_ROOM_SIZE=99\n' >>"$original_env"
      rm -f -- "$fake_root/mutate-original-env-after-config"
    fi
    printf '{"name":"round-linux-test","services":{"signaling":{"deploy":{"replicas":1}}},"volumes":{"caddy_data":{"name":"round-linux-test_caddy_data"},"caddy_config":{"name":"round-linux-test_caddy_config"}}}\n'
    ;;
  *' config --quiet '*)
    log_compose "$@"
    ;;
  *' ps --status running -q edge '*)
    [[ ! -e "$fake_root/edge-ps-fail" ]] || exit 1
    if [[ -e "$fake_root/edge-running" ]]; then
      printf 'edge-container\n'
    fi
    ;;
  *' ps --all -q '*) [[ ! -e "$fake_root/compose-ps-fail" ]] ;;
  *' pull edge signaling '*)
    log_compose "$@"
    if [[ -e "$fake_root/mutate-snapshot-after-pull" ]]; then
      previous=
      for argument in "$@"; do
        if [[ "$previous" == --env-file ]]; then
          printf '\nMAX_ROOM_SIZE=99\n' >>"$argument"
          break
        fi
        previous=$argument
      done
    fi
    ;;
  *' pull alloy '*) log_compose "$@" ;;
  *' up -d --wait --no-build --remove-orphans '*)
    log_compose "$@"
    if [[ -e "$fake_root/fail-up" ]]; then
      rm -f -- "$fake_root/fail-up"
      exit 42
    fi
    ;;
  *' up -d --wait --no-build --no-deps edge '*) log_compose "$@" ;;
  *' stop edge '*) log_compose "$@" ;;
  *' down --remove-orphans '*) log_compose "$@" ;;
  *' pull ghcr.io/ljkhyeong/round-edge@sha256:'*) log_compose "$@" ;;
  *' volume inspect '*)
    [[ ! -e "$fake_root/volumes-missing" ]]
    ;;
  *' volume create '*)
    printf 'volume-create %s\n' "$*" >>"$fake_root/docker.log"
    ;;
  *' --entrypoint tar '*)
    [[ ! -e "$fake_root/backup-archive-fail" ]] || exit 44
    cat "$fake_root/archive.tar"
    ;;
  *' --entrypoint sh '*) cat >/dev/null ;;
  *)
    printf 'unexpected fake docker invocation: %s\n' "$*" >&2
    exit 1
    ;;
esac
EOF
chmod 0700 \
  "$fake_bin/uname" \
  "$fake_bin/timedatectl" \
  "$fake_bin/df" \
  "$fake_bin/flock" \
  "$fake_bin/git" \
  "$fake_bin/gh" \
  "$fake_bin/age" \
  "$fake_bin/docker"

archive_root="$fixture_dir/archive"
mkdir -p "$archive_root/caddy_data" "$archive_root/caddy_config"
printf 'certificate-state\n' >"$archive_root/caddy_data/state.txt"
printf 'caddy-config\n' >"$archive_root/caddy_config/config.json"
tar -C "$archive_root" -cf "$fixture_dir/archive.tar" caddy_data caddy_config

state_dir="$fixture_dir/releases"
mkdir -p "$state_dir"
chmod 0700 "$state_dir"

stale_state_root="$fixture_dir/stale-state-root"
stale_state_dir="$stale_state_root/releases"
mkdir -p "$stale_state_dir" "$stale_state_root/.deploy-snapshot.interrupted"
chmod 0700 "$stale_state_root" "$stale_state_dir" \
  "$stale_state_root/.deploy-snapshot.interrupted"
cp -- "$env_a" "$stale_state_root/.deploy-snapshot.interrupted/runtime.env"
cp -- compose.yml "$stale_state_root/.deploy-snapshot.interrupted/compose.yml"
chmod 0600 "$stale_state_root/.deploy-snapshot.interrupted/runtime.env" \
  "$stale_state_root/.deploy-snapshot.interrupted/compose.yml"
: >"$fixture_dir/docker.log"
if PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$stale_state_dir" "$env_a" >/dev/null 2>&1; then
  fail 'deployment ignored a snapshot left by an interrupted lifecycle operation'
fi
[[ ! -s "$fixture_dir/docker.log" ]] ||
  fail 'stale snapshot rejection reached Docker'
rm -f -- "$stale_state_root/.deploy-snapshot.interrupted/runtime.env" \
  "$stale_state_root/.deploy-snapshot.interrupted/compose.yml"
rmdir -- "$stale_state_root/.deploy-snapshot.interrupted"

unreviewed_env="$fixture_dir/production-unreviewed-repository.env"
write_env \
  "$unreviewed_env" \
  "$digest_a" "$digest_b" \
  all \
  ghcr.io/attacker
unreviewed_state_dir="$fixture_dir/unreviewed-repository-releases"
mkdir "$unreviewed_state_dir"
chmod 0700 "$unreviewed_state_dir"
: >"$fixture_dir/docker.log"
if PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$unreviewed_state_dir" "$unreviewed_env" \
  >/dev/null 2>&1; then
  fail 'deployment accepted an unreviewed image repository'
fi
if grep -Fq 'pull edge signaling' "$fixture_dir/docker.log"; then
  fail 'an unreviewed image repository reached Docker pull'
fi
[[ ! -e "$unreviewed_state_dir/pending.env" && \
   ! -e "$unreviewed_state_dir/in-progress.env" ]] ||
  fail 'repository rejection created a deployment journal'
if find "$fixture_dir" -type d -name '.deploy-snapshot.*' -print -quit | grep -q .; then
  fail 'repository rejection left a transaction snapshot behind'
fi
: >"$fixture_dir/docker.log"
if PATH="$fake_bin:$PATH" \
  ops/linux/preflight.sh --state-dir "$unreviewed_state_dir" "$unreviewed_env" \
  >/dev/null 2>&1; then
  fail 'standalone preflight accepted an unreviewed image repository'
fi
[[ ! -s "$fixture_dir/docker.log" ]] ||
  fail 'standalone repository rejection reached Docker'

: >"$fixture_dir/docker.log"
ROUND_EDGE_IMAGE='attacker.invalid/edge:latest' \
ROUND_SIGNALING_IMAGE='attacker.invalid/signaling:latest' \
COMPOSE_FILE='/tmp/attacker-compose.yml' \
COMPOSE_PROJECT_NAME='attacker-project' \
NODE_IMAGE='attacker.invalid/node:latest' \
DOCKER_HOST='tcp://attacker.invalid:2376' \
DOCKER_CONTEXT='attacker-context' \
PATH="$fake_bin:$PATH" \
  ops/linux/preflight.sh --state-dir "$state_dir" "$env_a" >/dev/null
grep -Fq "edge=ghcr.io/ljkhyeong/round-edge@sha256:$digest_a" "$fixture_dir/docker.log" ||
  fail 'sanitized Compose did not receive the verified edge digest'
grep -Fq 'compose_file=unset compose_project=unset node_image=unset docker_host=unix:///var/run/docker.sock docker_context=unset' "$fixture_dir/docker.log" ||
  fail 'ambient Compose/build variables reached the sanitized Compose process'
if grep -Fq 'attacker.invalid' "$fixture_dir/docker.log"; then
  fail 'ambient attacker image reached Compose rendering'
fi
if PATH="$fake_bin:$PATH" \
  ops/linux/preflight.sh --state-dir "$state_dir" "$env_bad_provider" >/dev/null 2>&1; then
  fail 'disabled TURN provider was accepted for production'
fi

unsigned_state_dir="$fixture_dir/unsigned-releases"
mkdir "$unsigned_state_dir"
chmod 0700 "$unsigned_state_dir"
touch "$fixture_dir/fail-provenance"
: >"$fixture_dir/docker.log"
: >"$fixture_dir/gh.log"
if PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$unsigned_state_dir" "$env_a" >/dev/null 2>&1; then
  fail 'deployment accepted a release without valid signed provenance'
fi
rm -f -- "$fixture_dir/fail-provenance"
[[ "$(grep -c '^attestation-verify ' "$fixture_dir/gh.log")" == '1' ]] ||
  fail 'signed provenance failure did not stop at the first rejected image'
if grep -Fq 'pull edge signaling' "$fixture_dir/docker.log"; then
  fail 'invalid signed provenance reached Docker pull'
fi
[[ ! -e "$unsigned_state_dir/pending.env" && \
   ! -e "$unsigned_state_dir/in-progress.env" ]] ||
  fail 'signed provenance rejection created a deployment journal'
if find "$fixture_dir" -type d -name '.deploy-snapshot.*' -print -quit | grep -q .; then
  fail 'signed provenance rejection left a transaction snapshot behind'
fi

first_state_dir="$fixture_dir/first-releases"
mkdir -p "$first_state_dir"
chmod 0700 "$first_state_dir"
touch "$fixture_dir/fail-up"
if PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$first_state_dir" "$env_a" >/dev/null 2>&1; then
  fail 'simulated failed first deployment unexpectedly succeeded'
fi
[[ -e "$first_state_dir/in-progress.env" && ! -e "$first_state_dir/current.env" ]] ||
  fail 'failed first deployment did not preserve an abortable journal'
: >"$fixture_dir/docker.log"
PATH="$fake_bin:$PATH" ops/linux/rollback.sh \
  --state-dir "$first_state_dir" \
  --confirm ROLLBACK_ROUND \
  "$env_a" \
  >/dev/null
[[ ! -e "$first_state_dir/in-progress.env" && ! -e "$first_state_dir/current.env" ]] ||
  fail 'failed first deployment was not recovered to a stopped empty state'
grep -Eq -- 'down --remove-orphans.*--file .*/\.deploy-snapshot\.[^/]+/compose\.yml|--file .*/\.deploy-snapshot\.[^/]+/compose\.yml.*down --remove-orphans' \
  "$fixture_dir/docker.log" ||
  fail 'failed-first-deploy rollback did not use a Compose snapshot'
if find "$fixture_dir" -type d -name '.deploy-snapshot.*' -print -quit | grep -q .; then
  fail 'failed-first-deploy rollback left a transaction snapshot behind'
fi

touch "$fixture_dir/git-dirty"
if PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$state_dir" "$env_a" >/dev/null 2>&1; then
  fail 'deployment accepted a dirty reviewed checkout'
fi
rm -f -- "$fixture_dir/git-dirty"

: >"$fixture_dir/docker.log"
: >"$fixture_dir/gh.log"
PATH="$fake_bin:$PATH" ops/linux/deploy.sh --state-dir "$state_dir" "$env_a" >/dev/null
round_ops_validate_release_file "$state_dir/current.env"
[[ ! -e "$state_dir/previous.env" ]] || fail 'first deploy unexpectedly created previous.env'
[[ "$(grep -c '^attestation-verify ' "$fixture_dir/gh.log")" == '2' ]] ||
  fail 'deployment did not verify both signed image provenance statements'
[[ "$(grep -c '^image-inspect ' "$fixture_dir/docker.log")" == '2' ]] ||
  fail 'deployment did not snapshot image labels exactly once per digest'
grep -Fq -- "--project-directory $repo_root" "$fixture_dir/docker.log" ||
  fail 'snapshot Compose changed the reviewed project directory'
grep -Eq -- '--file .*/\.deploy-snapshot\.[^/]+/compose\.yml' "$fixture_dir/docker.log" ||
  fail 'deployment did not execute the snapshotted Compose file'
grep -Eq -- '--env-file .*/\.deploy-snapshot\.[^/]+/runtime\.env' "$fixture_dir/docker.log" ||
  fail 'deployment did not execute the snapshotted env file'
if find "$fixture_dir" -type d -name '.deploy-snapshot.*' -print -quit | grep -q .; then
  fail 'successful deployment left a transaction snapshot behind'
fi
if grep -Fq 'pull alloy' "$fixture_dir/docker.log"; then
  fail 'disabled observability profile pulled Alloy'
fi

observability_env="$fixture_dir/production-observability.env"
write_env \
  "$observability_env" "$digest_a" "$digest_b" all ghcr.io/ljkhyeong cloudflare observability
observability_state_dir="$fixture_dir/observability-releases"
mkdir "$observability_state_dir"
chmod 0700 "$observability_state_dir"
: >"$fixture_dir/docker.log"
PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$observability_state_dir" "$observability_env" >/dev/null
grep -Fq 'pull alloy' "$fixture_dir/docker.log" ||
  fail 'enabled observability profile did not pull Alloy'

printf 'ghcr.io/ljkhyeong/round-edge@sha256:%s\n' "$digest_a" \
  >"$fixture_dir/fail-provenance-reference"
: >"$fixture_dir/docker.log"
: >"$fixture_dir/gh.log"
if PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$state_dir" "$env_b" >/dev/null 2>&1; then
  fail 'deployment accepted an unsigned current rollback baseline'
fi
rm -f -- "$fixture_dir/fail-provenance-reference"
[[ "$(grep -c '^attestation-verify ' "$fixture_dir/gh.log")" == '1' ]] ||
  fail 'unsigned current rollback baseline did not stop at its first rejected image'
[[ ! -e "$state_dir/pending.env" && ! -e "$state_dir/in-progress.env" ]] ||
  fail 'unsigned current rollback baseline rejection created a deployment journal'
[[ ! -s "$fixture_dir/docker.log" ]] ||
  fail 'unsigned current rollback baseline rejection reached Docker'
if find "$fixture_dir" -type d -name '.deploy-snapshot.*' -print -quit | grep -q .; then
  fail 'unsigned current rollback baseline rejection left a transaction snapshot behind'
fi

wrong_role_state_dir="$fixture_dir/wrong-role-releases"
mkdir "$wrong_role_state_dir"
chmod 0700 "$wrong_role_state_dir"
touch "$fixture_dir/wrong-edge-role"
: >"$fixture_dir/docker.log"
if PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$wrong_role_state_dir" "$env_a" >/dev/null 2>&1; then
  fail 'deployment accepted an edge digest carrying the wrong role'
fi
rm -f -- "$fixture_dir/wrong-edge-role"
[[ -e "$wrong_role_state_dir/in-progress.env" ]] ||
  fail 'image-label failure did not preserve the deployment journal'
grep -Fq 'pull edge signaling' "$fixture_dir/docker.log" ||
  fail 'image label verification ran before pulling the selected digests'
if grep -Fq 'up -d --wait' "$fixture_dir/docker.log"; then
  fail 'deployment started containers after image-label failure'
fi
if find "$fixture_dir" -type d -name '.deploy-snapshot.*' -print -quit | grep -q .; then
  fail 'failed deployment left a transaction snapshot behind'
fi

wrong_flavor_state_dir="$fixture_dir/wrong-flavor-releases"
mkdir "$wrong_flavor_state_dir"
chmod 0700 "$wrong_flavor_state_dir"
touch "$fixture_dir/edge-flavor-relay"
if PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$wrong_flavor_state_dir" "$env_a" >/dev/null 2>&1; then
  fail 'standalone deployment accepted the relay-only edge flavor'
fi
rm -f -- "$fixture_dir/edge-flavor-relay"

mixed_release_state_dir="$fixture_dir/mixed-release-releases"
mkdir "$mixed_release_state_dir"
chmod 0700 "$mixed_release_state_dir"
touch "$fixture_dir/mixed-release"
if PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$mixed_release_state_dir" "$env_a" >/dev/null 2>&1; then
  fail 'deployment accepted images from different annotated tag objects'
fi
rm -f -- "$fixture_dir/mixed-release"

mutated_snapshot_state_dir="$fixture_dir/mutated-snapshot-releases"
mkdir "$mutated_snapshot_state_dir"
chmod 0700 "$mutated_snapshot_state_dir"
touch "$fixture_dir/mutate-snapshot-after-pull"
: >"$fixture_dir/docker.log"
if PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$mutated_snapshot_state_dir" "$env_a" >/dev/null 2>&1; then
  fail 'deployment accepted a runtime snapshot changed after preflight'
fi
rm -f -- "$fixture_dir/mutate-snapshot-after-pull"
[[ -e "$mutated_snapshot_state_dir/in-progress.env" ]] ||
  fail 'snapshot-integrity failure did not preserve the deployment journal'
if grep -Fq 'image-inspect ' "$fixture_dir/docker.log" ||
   grep -Fq 'up -d --wait' "$fixture_dir/docker.log"; then
  fail 'changed deployment snapshot reached image-label verification or container startup'
fi

relay_env="$fixture_dir/production-relay.env"
write_env "$relay_env" "$digest_a" "$digest_b" relay
relay_state_dir="$fixture_dir/relay-releases"
mkdir "$relay_state_dir"
chmod 0700 "$relay_state_dir"
touch "$fixture_dir/edge-flavor-relay"
PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$relay_state_dir" "$relay_env" >/dev/null
rm -f -- "$fixture_dir/edge-flavor-relay"
round_ops_validate_release_file "$relay_state_dir/current.env"

touch "$fixture_dir/flock-fail"
if PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$state_dir" "$env_b" >/dev/null 2>&1; then
  fail 'deployment ignored the lifecycle lock'
fi
rm -f -- "$fixture_dir/flock-fail"
[[ ! -e "$state_dir/in-progress.env" ]] ||
  fail 'lock rejection mutated deployment state'

: >"$fixture_dir/gh.log"
PATH="$fake_bin:$PATH" ops/linux/deploy.sh --state-dir "$state_dir" "$env_b" >/dev/null
[[ "$(grep -c '^attestation-verify ' "$fixture_dir/gh.log")" == '4' ]] ||
  fail 'second deployment did not verify both current and candidate image provenance'
current_edge=$(round_ops_read_env_value "$state_dir/current.env" ROUND_EDGE_IMAGE)
previous_edge=$(round_ops_read_env_value "$state_dir/previous.env" ROUND_EDGE_IMAGE)
[[ "$current_edge" == "ghcr.io/ljkhyeong/round-edge@sha256:$digest_d" ]] ||
  fail 'second deploy was not recorded'
[[ "$previous_edge" == "ghcr.io/ljkhyeong/round-edge@sha256:$digest_a" ]] ||
  fail 'previous release was not preserved'

touch "$fixture_dir/wrong-edge-role"
: >"$fixture_dir/docker.log"
if PATH="$fake_bin:$PATH" ops/linux/rollback.sh \
  --state-dir "$state_dir" \
  --confirm ROLLBACK_ROUND \
  "$env_b" \
  >/dev/null 2>&1; then
  fail 'rollback accepted an edge digest carrying the TURN role'
fi
rm -f -- "$fixture_dir/wrong-edge-role"
[[ -e "$state_dir/rollback-in-progress.env" && -e "$state_dir/rollback-origin.env" ]] ||
  fail 'image-label failure did not preserve the rollback journal'
grep -Fq 'pull edge signaling' "$fixture_dir/docker.log" ||
  fail 'rollback image label verification ran before pulling the selected digests'
if grep -Fq 'up -d --wait' "$fixture_dir/docker.log"; then
  fail 'rollback started containers after image-label failure'
fi
if find "$fixture_dir" -type d -name '.deploy-snapshot.*' -print -quit | grep -q .; then
  fail 'failed rollback image label verification left a transaction snapshot behind'
fi
: >"$fixture_dir/gh.log"
PATH="$fake_bin:$PATH" ops/linux/rollback.sh \
  --state-dir "$state_dir" \
  --confirm ROLLBACK_ROUND \
  "$env_b" \
  >/dev/null
[[ "$(grep -c '^attestation-verify ' "$fixture_dir/gh.log")" == '2' ]] ||
  fail 'rollback did not verify both signed image provenance statements'

rollback_env="$fixture_dir/rollback-runtime.env"
cp -- "$env_b" "$rollback_env"
chmod 0600 "$rollback_env"
printf '%s\n' "$rollback_env" >"$fixture_dir/mutate-original-env-after-config"
: >"$fixture_dir/docker.log"
PATH="$fake_bin:$PATH" ops/linux/rollback.sh \
  --state-dir "$state_dir" \
  --confirm ROLLBACK_ROUND \
  "$rollback_env" \
  >/dev/null
[[ ! -e "$fixture_dir/mutate-original-env-after-config" ]] ||
  fail 'rollback test did not mutate the original env after snapshot preflight'
grep -Fq 'MAX_ROOM_SIZE=99' "$rollback_env" ||
  fail 'rollback source env mutation was not applied'
if grep -Fq -- "--env-file $rollback_env" "$fixture_dir/docker.log"; then
  fail 'rollback executed the original env instead of its snapshot'
fi
grep -Eq -- '--file .*/\.deploy-snapshot\.[^/]+/compose\.yml' \
  "$fixture_dir/docker.log" ||
  fail 'rollback did not execute the snapshotted Compose file'
grep -Eq -- '--env-file .*/\.deploy-snapshot\.[^/]+/runtime\.env' \
  "$fixture_dir/docker.log" ||
  fail 'rollback did not execute the snapshotted env file'
if find "$fixture_dir" -type d -name '.deploy-snapshot.*' -print -quit | grep -q .; then
  fail 'successful rollback left a transaction snapshot behind'
fi
current_edge=$(round_ops_read_env_value "$state_dir/current.env" ROUND_EDGE_IMAGE)
previous_edge=$(round_ops_read_env_value "$state_dir/previous.env" ROUND_EDGE_IMAGE)
[[ "$current_edge" == "ghcr.io/ljkhyeong/round-edge@sha256:$digest_a" ]] ||
  fail 'rollback target was not recorded'
[[ "$previous_edge" == "ghcr.io/ljkhyeong/round-edge@sha256:$digest_d" ]] ||
  fail 'rollback did not preserve roll-forward state'

touch "$fixture_dir/fail-up"
if PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$state_dir" "$env_b" >/dev/null 2>&1; then
  fail 'simulated failed deployment unexpectedly succeeded'
fi
[[ -e "$state_dir/in-progress.env" ]] ||
  fail 'failed deployment did not leave an explicit in-progress marker'
current_edge=$(round_ops_read_env_value "$state_dir/current.env" ROUND_EDGE_IMAGE)
[[ "$current_edge" == "ghcr.io/ljkhyeong/round-edge@sha256:$digest_a" ]] ||
  fail 'failed deployment replaced the last verified current state'
PATH="$fake_bin:$PATH" ops/linux/rollback.sh \
  --state-dir "$state_dir" \
  --confirm ROLLBACK_ROUND \
  "$env_b" \
  >/dev/null
[[ ! -e "$state_dir/in-progress.env" ]] ||
  fail 'failed-deployment recovery left the in-progress marker behind'
current_edge=$(round_ops_read_env_value "$state_dir/current.env" ROUND_EDGE_IMAGE)
[[ "$current_edge" == "ghcr.io/ljkhyeong/round-edge@sha256:$digest_a" ]] ||
  fail 'failed-deployment recovery did not redeploy current state'

touch "$fixture_dir/fail-up"
if PATH="$fake_bin:$PATH" ops/linux/rollback.sh \
  --state-dir "$state_dir" \
  --confirm ROLLBACK_ROUND \
  "$env_b" \
  >/dev/null 2>&1; then
  fail 'simulated failed rollback unexpectedly succeeded'
fi
[[ -e "$state_dir/rollback-in-progress.env" && -e "$state_dir/rollback-origin.env" ]] ||
  fail 'failed rollback did not preserve its recovery journal'
if find "$fixture_dir" -type d -name '.deploy-snapshot.*' -print -quit | grep -q .; then
  fail 'failed rollback left a transaction snapshot behind'
fi
if PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$state_dir" "$env_b" >/dev/null 2>&1; then
  fail 'deploy was allowed while rollback recovery was pending'
fi
PATH="$fake_bin:$PATH" ops/linux/rollback.sh \
  --state-dir "$state_dir" \
  --confirm ROLLBACK_ROUND \
  "$env_b" \
  >/dev/null
[[ ! -e "$state_dir/rollback-in-progress.env" && ! -e "$state_dir/rollback-origin.env" ]] ||
  fail 'interrupted rollback recovery left journal files behind'
current_edge=$(round_ops_read_env_value "$state_dir/current.env" ROUND_EDGE_IMAGE)
[[ "$current_edge" == "ghcr.io/ljkhyeong/round-edge@sha256:$digest_a" ]] ||
  fail 'interrupted rollback recovery did not restore verified current state'

changed_env="$fixture_dir/production-config-changed.env"
cp "$env_a" "$changed_env"
printf 'MAX_ROOM_SIZE=7\n' >>"$changed_env"
chmod 0600 "$changed_env"
if (round_ops_assert_state_compatible "$state_dir/current.env" "$changed_env" 2>/dev/null); then
  fail 'changed runtime config was accepted for a saved release state'
fi

recipient_file="$fixture_dir/backup-recipients.txt"
printf 'age1testrecipient\n' >"$recipient_file"
backup_dir="$fixture_dir/backups"
failed_backup_dir="$fixture_dir/failed-backups"
touch "$fixture_dir/edge-ps-fail"
if PATH="$fake_bin:$PATH" ops/linux/backup-caddy.sh \
  --state-dir "$state_dir" \
  --recipient-file "$recipient_file" \
  --output-dir "$failed_backup_dir" \
  "$env_b" \
  >/dev/null 2>&1; then
  fail 'Caddy backup ignored an edge container status lookup failure'
fi
rm -f -- "$fixture_dir/edge-ps-fail"
if find "$failed_backup_dir" -type f -print -quit | grep -q .; then
  fail 'failed edge container status lookup left a backup artifact'
fi
PATH="$fake_bin:$PATH" ops/linux/backup-caddy.sh \
  --state-dir "$state_dir" \
  --recipient-file "$recipient_file" \
  --output-dir "$backup_dir" \
  "$env_b" \
  >/dev/null
backup_file=$(printf '%s\n' "$backup_dir"/*.tar.age)
[[ -s "$backup_file" && -s "$backup_file.sha256" ]] ||
  fail 'encrypted backup and checksum were not created'

running_backup_dir="$fixture_dir/running-backups"
touch "$fixture_dir/edge-running"
: >"$fixture_dir/docker.log"
PATH="$fake_bin:$PATH" ops/linux/backup-caddy.sh \
  --state-dir "$state_dir" \
  --recipient-file "$recipient_file" \
  --output-dir "$running_backup_dir" \
  "$env_b" \
  >/dev/null
rm -f -- "$fixture_dir/edge-running"
[[ "$(grep -c 'stop edge' "$fixture_dir/docker.log")" == '1' ]] ||
  fail 'backup did not stop a running edge exactly once'
[[ "$(grep -c 'up -d --wait --no-build --no-deps edge' "$fixture_dir/docker.log")" == '1' ]] ||
  fail 'backup did not restart a running edge exactly once'

failed_running_backup_dir="$fixture_dir/failed-running-backups"
touch "$fixture_dir/edge-running" "$fixture_dir/backup-archive-fail"
: >"$fixture_dir/docker.log"
if PATH="$fake_bin:$PATH" ops/linux/backup-caddy.sh \
  --state-dir "$state_dir" \
  --recipient-file "$recipient_file" \
  --output-dir "$failed_running_backup_dir" \
  "$env_b" \
  >/dev/null 2>&1; then
  fail 'Caddy backup ignored an archive creation failure'
fi
rm -f -- \
  "$fixture_dir/edge-running" \
  "$fixture_dir/backup-archive-fail"
[[ "$(grep -c 'stop edge' "$fixture_dir/docker.log")" == '1' ]] ||
  fail 'failed backup did not stop a running edge exactly once'
[[ "$(grep -c 'up -d --wait --no-build --no-deps edge' "$fixture_dir/docker.log")" == '1' ]] ||
  fail 'failed backup did not restart a running edge exactly once'
if find "$failed_running_backup_dir" -type f -print -quit | grep -q .; then
  fail 'failed running-edge backup left a backup artifact'
fi

identity_file="$fixture_dir/backup-identity.txt"
printf 'AGE-SECRET-KEY-TEST\n' >"$identity_file"
chmod 0600 "$identity_file"

mutable_backup="$fixture_dir/mutable-caddy.tar.age"
cp -- "$backup_file" "$mutable_backup"
cp -- "$backup_file.sha256" "$mutable_backup.sha256"
printf '%s\n' "$mutable_backup" >"$fixture_dir/mutate-backup-after-decrypt"
: >"$fixture_dir/age.log"
PATH="$fake_bin:$PATH" ops/linux/restore-caddy.sh \
  --state-dir "$state_dir" \
  --identity-file "$identity_file" \
  --confirm RESTORE_CADDY_VOLUMES \
  "$mutable_backup" \
  "$env_b" \
  >/dev/null
grep -Fxq 'changed external backup' "$mutable_backup" ||
  fail 'restore snapshot test did not mutate the external backup'
[[ "$(wc -l <"$fixture_dir/age.log" | tr -d ' ')" == '3' ]] ||
  fail 'restore did not decrypt the expected archive streams'
restore_snapshot=$(awk 'NR == 1 { print $2 }' "$fixture_dir/age.log")
[[ "$restore_snapshot" != "$mutable_backup" ]] ||
  fail 'restore decrypted the external backup path instead of its snapshot'
if awk -v expected="$restore_snapshot" '$2 != expected { exit 1 }' \
  "$fixture_dir/age.log"; then
  :
else
  fail 'restore used different encrypted bytes between validation and extraction'
fi
[[ ! -e "$restore_snapshot" ]] ||
  fail 'restore left its encrypted backup snapshot behind'

touch "$fixture_dir/compose-ps-fail"
if PATH="$fake_bin:$PATH" ops/linux/restore-caddy.sh \
  --state-dir "$state_dir" \
  --identity-file "$identity_file" \
  --confirm RESTORE_CADDY_VOLUMES \
  "$backup_file" \
  "$env_b" \
  >/dev/null 2>&1; then
  fail 'Caddy restore ignored a Compose container status lookup failure'
fi
rm -f -- "$fixture_dir/compose-ps-fail"

fresh_restore_root="$fixture_dir/fresh-restore-root"
fresh_restore_state_dir="$fresh_restore_root/releases"
mkdir -p "$fresh_restore_state_dir"
chmod 0700 "$fresh_restore_root" "$fresh_restore_state_dir"
touch "$fixture_dir/wrong-edge-role"
: >"$fixture_dir/docker.log"
if PATH="$fake_bin:$PATH" ops/linux/restore-caddy.sh \
  --state-dir "$fresh_restore_state_dir" \
  --identity-file "$identity_file" \
  --confirm RESTORE_CADDY_VOLUMES \
  "$backup_file" \
  "$env_a" \
  >/dev/null 2>&1; then
  fail 'fresh-host restore accepted an image without the edge role'
fi
rm -f -- "$fixture_dir/wrong-edge-role"
if grep -Fq -- '--entrypoint sh' "$fixture_dir/docker.log"; then
  fail 'untrusted fresh-host helper image reached archive extraction'
fi

touch "$fixture_dir/edge-flavor-relay"
: >"$fixture_dir/docker.log"
if PATH="$fake_bin:$PATH" ops/linux/restore-caddy.sh \
  --state-dir "$fresh_restore_state_dir" \
  --identity-file "$identity_file" \
  --confirm RESTORE_CADDY_VOLUMES \
  "$backup_file" \
  "$env_a" \
  >/dev/null 2>&1; then
  fail 'fresh-host restore accepted an edge helper with the wrong flavor'
fi
rm -f -- "$fixture_dir/edge-flavor-relay"
if grep -Fq -- '--entrypoint sh' "$fixture_dir/docker.log"; then
  fail 'wrong-flavor fresh-host helper image reached archive extraction'
fi

touch "$fixture_dir/volumes-missing"
touch "$fixture_dir/omit-edge-release-metadata"
: >"$fixture_dir/docker.log"
: >"$fixture_dir/gh.log"
PATH="$fake_bin:$PATH" ops/linux/restore-caddy.sh \
  --state-dir "$fresh_restore_state_dir" \
  --identity-file "$identity_file" \
  --confirm RESTORE_CADDY_VOLUMES \
  "$backup_file" \
  "$env_a" \
  >/dev/null
rm -f -- "$fixture_dir/omit-edge-release-metadata"
grep -Fq 'volume-create volume create' "$fixture_dir/docker.log" ||
  fail 'fresh-host restore did not create missing Compose volumes'
[[ "$(grep -c '^attestation-verify ' "$fixture_dir/gh.log")" == '1' ]] ||
  fail 'fresh-host restore did not verify the edge helper provenance'
[[ "$(grep -c '^image-inspect .*round-edge@' "$fixture_dir/docker.log")" == '1' ]] ||
  fail 'fresh-host restore did not verify the edge helper release role'
grep -Fq 'pull ghcr.io/ljkhyeong/round-edge@sha256:' "$fixture_dir/docker.log" ||
  fail 'fresh-host restore did not pull the verified edge helper digest'
if find "$fresh_restore_root" -maxdepth 1 -name '.restore-backup.*' -print -quit | grep -q .; then
  fail 'fresh-host restore left its encrypted backup snapshot behind'
fi

for unit_file in \
  ops/linux/systemd/round-offsite-backup.service \
  ops/linux/systemd/round-offsite-maintenance.service; do
  grep -Fxq 'OnFailure=round-ops-failure@%n.service' "$unit_file" ||
    fail "백업 실패 기록 설정이 없습니다: $unit_file"
  if grep -Eq '^(Condition|Assert)[[:alnum:]]+=' "$unit_file"; then
    fail "백업 실패 처리를 건너뛰는 사전 조건이 있습니다: $unit_file"
  fi
done

grep -Fq 'ExecStart=/usr/bin/restic --retry-lock 5m backup' \
  ops/linux/systemd/round-offsite-backup.service
grep -Fq -- '--keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune' \
  ops/linux/systemd/round-offsite-maintenance.service
grep -Fq 'ExecStart=/usr/bin/restic --retry-lock 5m check' \
  ops/linux/systemd/round-offsite-maintenance.service
grep -Fq 'Persistent=false' ops/linux/systemd/round-offsite-backup.timer
grep -Fq 'Persistent=true' ops/linux/systemd/round-offsite-maintenance.timer
grep -Fq 'd /var/backups/round 0700 root root 30d' \
  ops/linux/tmpfiles.d/round-backups.conf

printf 'ROUND Linux operations tests passed.\n'
