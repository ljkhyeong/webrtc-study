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

openssl req \
  -x509 \
  -newkey rsa:2048 \
  -nodes \
  -days 30 \
  -subj '/CN=turn.round.invalid' \
  -addext 'subjectAltName=DNS:turn.round.invalid' \
  -keyout "$fixture_dir/turn-key.pem" \
  -out "$fixture_dir/turn-cert.pem" \
  >/dev/null 2>&1

digest_a=$(printf 'a%.0s' {1..64})
digest_b=$(printf 'b%.0s' {1..64})
digest_c=$(printf 'c%.0s' {1..64})
digest_d=$(printf 'd%.0s' {1..64})
digest_e=$(printf 'e%.0s' {1..64})
digest_f=$(printf 'f%.0s' {1..64})

write_env() {
  local destination=$1
  local edge_digest=$2
  local signaling_digest=$3
  local turn_digest=$4
  local turn_secret=${5:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}
  cat >"$destination" <<EOF
COMPOSE_PROJECT_NAME=round-linux-test
ROUND_EDGE_IMAGE=registry.invalid/round-edge@sha256:$edge_digest
ROUND_SIGNALING_IMAGE=registry.invalid/round-signaling@sha256:$signaling_digest
ROUND_TURN_IMAGE=registry.invalid/round-turn@sha256:$turn_digest
ROUND_DOMAIN=round.round.invalid
ALLOWED_ORIGINS=https://round.round.invalid
TURN_REALM=turn.round.invalid
TURN_EXTERNAL_IP=203.0.113.10
TURN_RELAY_IP=10.0.0.10
TURN_MIN_PORT=49160
TURN_MAX_PORT=49259
ROUND_ACCESS_PASSWORD_HASH='\$2a\$12\$RJKd/exBEqUGjd.mtH9URu8H/TGJgwahZV8tA.xhPCM/4rdHfpmYS'
TURN_SHARED_SECRET=$turn_secret
TURN_TLS_CERT_FILE=$fixture_dir/turn-cert.pem
TURN_TLS_KEY_FILE=$fixture_dir/turn-key.pem
EOF
  chmod 0600 "$destination"
}

env_a="$fixture_dir/production-a.env"
env_b="$fixture_dir/production-b.env"
env_bad_secret="$fixture_dir/production-bad-secret.env"
write_env "$env_a" "$digest_a" "$digest_b" "$digest_c"
write_env "$env_b" "$digest_d" "$digest_e" "$digest_f"
write_env \
  "$env_bad_secret" \
  "$digest_a" \
  "$digest_b" \
  "$digest_c" \
  'gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg'

round_ops_require_private_file "$env_a"
round_ops_validate_certificate "$env_a" 0
chmod 0644 "$fixture_dir/turn-key.pem"
if (round_ops_validate_certificate "$env_a" 0 2>/dev/null); then
  fail 'world-readable TURN private key was accepted'
fi
chmod 0600 "$fixture_dir/turn-key.pem"
round_ops_validate_digest_ref \
  ROUND_EDGE_IMAGE \
  "registry.invalid/round-edge@sha256:$digest_a"
if (round_ops_validate_digest_ref ROUND_EDGE_IMAGE 'registry.invalid/round-edge:latest' 2>/dev/null); then
  fail 'mutable image tag was accepted'
fi
if (round_ops_prepare_private_directory /var >/dev/null 2>&1); then
  fail 'broad private directory target was accepted'
fi

release_file="$fixture_dir/release.env"
round_ops_write_release_file \
  "$release_file" \
  "$env_a" \
  "registry.invalid/round-edge@sha256:$digest_a" \
  "registry.invalid/round-signaling@sha256:$digest_b" \
  "registry.invalid/round-turn@sha256:$digest_c"
round_ops_validate_release_file "$release_file"

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
cat >"$fake_bin/timeout" <<'EOF'
#!/usr/bin/env bash
fake_root=$(cd -- "$(dirname -- "$0")/.." && pwd)
[[ ! -e "$fake_root/tls-fail" ]] || exit 124
if [[ -e "$fake_root/tls-fail-once" ]]; then
  rm -f -- "$fake_root/tls-fail-once"
  exit 124
fi
cat "$fake_root/turn-cert.pem"
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
  *' diff '*) [[ ! -e "$fake_root/git-dirty" ]] ;;
  *' ls-files --others --exclude-standard '*) exit 0 ;;
  *)
    printf 'unexpected fake git invocation: %s\n' "$*" >&2
    exit 1
    ;;
esac
EOF
cat >"$fake_bin/age" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *' --decrypt '* ]]; then
  cat "${@: -1}"
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
  printf 'args=%s edge=%s signaling=%s turn=%s compose_file=%s compose_project=%s node_image=%s docker_host=%s docker_context=%s\n' \
    "$*" \
    "${ROUND_EDGE_IMAGE-unset}" \
    "${ROUND_SIGNALING_IMAGE-unset}" \
    "${ROUND_TURN_IMAGE-unset}" \
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
  *' info '*) ;;
  *' config --format json '*)
    log_compose "$@"
    printf '{"name":"round-linux-test","services":{"signaling":{"deploy":{"replicas":1}}},"volumes":{"caddy_data":{"name":"round-linux-test_caddy_data"},"caddy_config":{"name":"round-linux-test_caddy_config"}}}\n'
    ;;
  *' config --quiet '*) log_compose "$@" ;;
  *' ps --status running --services '*) printf 'edge\nsignaling\nturn\n' ;;
  *' ps --status running -q edge '*) ;;
  *' ps --all -q '*) ;;
  *' pull edge signaling turn '*) log_compose "$@" ;;
  *' up -d --wait --no-build --remove-orphans '*)
    log_compose "$@"
    if [[ -e "$fake_root/fail-up" ]]; then
      rm -f -- "$fake_root/fail-up"
      exit 42
    fi
    ;;
  *' up -d --wait --no-build --no-deps --force-recreate turn '*) log_compose "$@" ;;
  *' up -d --wait --no-build --no-deps edge '*) log_compose "$@" ;;
  *' stop edge '*) log_compose "$@" ;;
  *' down --remove-orphans '*) log_compose "$@" ;;
  *' volume inspect '*)
    [[ ! -e "$fake_root/volumes-missing" ]]
    ;;
  *' volume create '*)
    printf 'volume-create %s\n' "$*" >>"$fake_root/docker.log"
    ;;
  *' --entrypoint tar '*) cat "$fake_root/archive.tar" ;;
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
  "$fake_bin/timeout" \
  "$fake_bin/df" \
  "$fake_bin/flock" \
  "$fake_bin/git" \
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
: >"$fixture_dir/docker.log"
ROUND_EDGE_IMAGE='attacker.invalid/edge:latest' \
ROUND_SIGNALING_IMAGE='attacker.invalid/signaling:latest' \
ROUND_TURN_IMAGE='attacker.invalid/turn:latest' \
COMPOSE_FILE='/tmp/attacker-compose.yml' \
COMPOSE_PROJECT_NAME='attacker-project' \
NODE_IMAGE='attacker.invalid/node:latest' \
DOCKER_HOST='tcp://attacker.invalid:2376' \
DOCKER_CONTEXT='attacker-context' \
PATH="$fake_bin:$PATH" \
  ops/linux/preflight.sh --state-dir "$state_dir" "$env_a" >/dev/null
grep -Fq "edge=registry.invalid/round-edge@sha256:$digest_a" "$fixture_dir/docker.log" ||
  fail 'sanitized Compose did not receive the verified edge digest'
grep -Fq 'compose_file=unset compose_project=unset node_image=unset docker_host=unix:///var/run/docker.sock docker_context=unset' "$fixture_dir/docker.log" ||
  fail 'ambient Compose/build variables reached the sanitized Compose process'
if grep -Fq 'attacker.invalid' "$fixture_dir/docker.log"; then
  fail 'ambient attacker image reached Compose rendering'
fi
if PATH="$fake_bin:$PATH" \
  ops/linux/preflight.sh --state-dir "$state_dir" "$env_bad_secret" >/dev/null 2>&1; then
  fail 'non-hexadecimal TURN shared secret was accepted'
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
PATH="$fake_bin:$PATH" ops/linux/rollback.sh \
  --state-dir "$first_state_dir" \
  --confirm ROLLBACK_ROUND \
  "$env_a" \
  >/dev/null
[[ ! -e "$first_state_dir/in-progress.env" && ! -e "$first_state_dir/current.env" ]] ||
  fail 'failed first deployment was not recovered to a stopped empty state'

touch "$fixture_dir/git-dirty"
if PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$state_dir" "$env_a" >/dev/null 2>&1; then
  fail 'deployment accepted a dirty reviewed checkout'
fi
rm -f -- "$fixture_dir/git-dirty"

PATH="$fake_bin:$PATH" ops/linux/deploy.sh --state-dir "$state_dir" "$env_a" >/dev/null
round_ops_validate_release_file "$state_dir/current.env"
[[ ! -e "$state_dir/previous.env" ]] || fail 'first deploy unexpectedly created previous.env'

touch "$fixture_dir/flock-fail"
if PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$state_dir" "$env_b" >/dev/null 2>&1; then
  fail 'deployment ignored the lifecycle lock'
fi
rm -f -- "$fixture_dir/flock-fail"
[[ ! -e "$state_dir/in-progress.env" ]] ||
  fail 'lock rejection mutated deployment state'

PATH="$fake_bin:$PATH" ops/linux/deploy.sh --state-dir "$state_dir" "$env_b" >/dev/null
current_edge=$(round_ops_read_env_value "$state_dir/current.env" ROUND_EDGE_IMAGE)
previous_edge=$(round_ops_read_env_value "$state_dir/previous.env" ROUND_EDGE_IMAGE)
[[ "$current_edge" == "registry.invalid/round-edge@sha256:$digest_d" ]] ||
  fail 'second deploy was not recorded'
[[ "$previous_edge" == "registry.invalid/round-edge@sha256:$digest_a" ]] ||
  fail 'previous release was not preserved'

PATH="$fake_bin:$PATH" ops/linux/rollback.sh \
  --state-dir "$state_dir" \
  --confirm ROLLBACK_ROUND \
  "$env_b" \
  >/dev/null
current_edge=$(round_ops_read_env_value "$state_dir/current.env" ROUND_EDGE_IMAGE)
previous_edge=$(round_ops_read_env_value "$state_dir/previous.env" ROUND_EDGE_IMAGE)
[[ "$current_edge" == "registry.invalid/round-edge@sha256:$digest_a" ]] ||
  fail 'rollback target was not recorded'
[[ "$previous_edge" == "registry.invalid/round-edge@sha256:$digest_d" ]] ||
  fail 'rollback did not preserve roll-forward state'

touch "$fixture_dir/fail-up"
if PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$state_dir" "$env_b" >/dev/null 2>&1; then
  fail 'simulated failed deployment unexpectedly succeeded'
fi
[[ -e "$state_dir/in-progress.env" ]] ||
  fail 'failed deployment did not leave an explicit in-progress marker'
current_edge=$(round_ops_read_env_value "$state_dir/current.env" ROUND_EDGE_IMAGE)
[[ "$current_edge" == "registry.invalid/round-edge@sha256:$digest_a" ]] ||
  fail 'failed deployment replaced the last verified current state'
PATH="$fake_bin:$PATH" ops/linux/rollback.sh \
  --state-dir "$state_dir" \
  --confirm ROLLBACK_ROUND \
  "$env_b" \
  >/dev/null
[[ ! -e "$state_dir/in-progress.env" ]] ||
  fail 'failed-deployment recovery left the in-progress marker behind'
current_edge=$(round_ops_read_env_value "$state_dir/current.env" ROUND_EDGE_IMAGE)
[[ "$current_edge" == "registry.invalid/round-edge@sha256:$digest_a" ]] ||
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
if PATH="$fake_bin:$PATH" \
  ops/linux/deploy.sh --state-dir "$state_dir" "$env_b" >/dev/null 2>&1; then
  fail 'deploy was allowed while rollback recovery was pending'
fi
if PATH="$fake_bin:$PATH" ops/linux/reload-turn-certificate.sh \
  --release-state-dir "$state_dir" \
  --certificate-state-dir "$fixture_dir/pre-recovery-certificates" \
  "$env_b" \
  >/dev/null 2>&1; then
  fail 'certificate reload was allowed while rollback recovery was pending'
fi
PATH="$fake_bin:$PATH" ops/linux/rollback.sh \
  --state-dir "$state_dir" \
  --confirm ROLLBACK_ROUND \
  "$env_b" \
  >/dev/null
[[ ! -e "$state_dir/rollback-in-progress.env" && ! -e "$state_dir/rollback-origin.env" ]] ||
  fail 'interrupted rollback recovery left journal files behind'
current_edge=$(round_ops_read_env_value "$state_dir/current.env" ROUND_EDGE_IMAGE)
[[ "$current_edge" == "registry.invalid/round-edge@sha256:$digest_a" ]] ||
  fail 'interrupted rollback recovery did not restore verified current state'

changed_env="$fixture_dir/production-config-changed.env"
cp "$env_a" "$changed_env"
printf 'MAX_ROOM_SIZE=7\n' >>"$changed_env"
chmod 0600 "$changed_env"
if (round_ops_assert_state_compatible "$state_dir/current.env" "$changed_env" 2>/dev/null); then
  fail 'changed runtime config was accepted for a saved release state'
fi

certificate_state="$fixture_dir/certificates"
: >"$fixture_dir/docker.log"
touch "$fixture_dir/tls-fail"
if PATH="$fake_bin:$PATH" ops/linux/reload-turn-certificate.sh \
  --release-state-dir "$state_dir" \
  --certificate-state-dir "$certificate_state" \
  "$env_b" \
  >/dev/null 2>&1; then
  fail 'certificate reload accepted a failing live TLS listener'
fi
[[ ! -e "$certificate_state/turn-certificate.sha256" ]] ||
  fail 'failed live TLS verification recorded an applied fingerprint'
rm -f -- "$fixture_dir/tls-fail"
PATH="$fake_bin:$PATH" ops/linux/reload-turn-certificate.sh \
  --release-state-dir "$state_dir" \
  --certificate-state-dir "$certificate_state" \
  "$env_b" \
  >/dev/null
[[ -s "$certificate_state/turn-certificate.sha256" ]] ||
  fail 'certificate deploy hook did not record its fingerprint'
unchanged_output=$(PATH="$fake_bin:$PATH" ops/linux/reload-turn-certificate.sh \
  --release-state-dir "$state_dir" \
  --certificate-state-dir "$certificate_state" \
  "$env_b")
[[ "$unchanged_output" == *'unchanged'* ]] || fail 'unchanged certificate was not a no-op'
grep -Fq "edge=registry.invalid/round-edge@sha256:$digest_a" "$fixture_dir/docker.log" ||
  fail 'certificate reload did not use the verified current release state'
touch "$fixture_dir/tls-fail-once"
PATH="$fake_bin:$PATH" ops/linux/reload-turn-certificate.sh \
  --release-state-dir "$state_dir" \
  --certificate-state-dir "$certificate_state" \
  "$env_b" \
  >/dev/null 2>&1
[[ ! -e "$fixture_dir/tls-fail-once" ]] ||
  fail 'stale listener reconciliation did not retry after recreation'

ROUND_ENV_FILE="$env_b" \
ROUND_CERTIFICATE_STATE_DIR="$certificate_state" \
PATH="$fake_bin:$PATH" \
  ops/linux/certbot/round-turn-certificate-check >/dev/null
touch "$fixture_dir/tls-fail"
if ROUND_ENV_FILE="$env_b" \
  ROUND_CERTIFICATE_STATE_DIR="$certificate_state" \
  PATH="$fake_bin:$PATH" \
  ops/linux/certbot/round-turn-certificate-check >/dev/null 2>&1; then
  fail 'certificate checker accepted a failing live TLS listener'
fi
rm -f -- "$fixture_dir/tls-fail"

reconcile_environment=(
  "ROUND_ENV_FILE=$env_b"
  "ROUND_RELEASE_STATE_DIR=$state_dir"
  "ROUND_CERTIFICATE_STATE_DIR=$certificate_state"
  "ROUND_TURN_RELOAD_SCRIPT=$repo_root/ops/linux/reload-turn-certificate.sh"
  "ROUND_TURN_CERTIFICATE_CHECK_SCRIPT=$repo_root/ops/linux/certbot/round-turn-certificate-check"
  "PATH=$fake_bin:$PATH"
)
env "${reconcile_environment[@]}" \
  ops/linux/certbot/round-turn-certificate-reconcile >/dev/null
touch "$fixture_dir/flock-fail"
if env \
  "${reconcile_environment[@]}" \
  "ROUND_TURN_RECONCILE_SCRIPT=$repo_root/ops/linux/certbot/round-turn-certificate-reconcile" \
  ops/linux/certbot/round-turn-deploy-hook >/dev/null 2>&1; then
  fail 'Certbot hook ignored a lifecycle lock failure'
fi
rm -f -- "$fixture_dir/flock-fail"
env \
  "${reconcile_environment[@]}" \
  "ROUND_TURN_RECONCILE_SCRIPT=$repo_root/ops/linux/certbot/round-turn-certificate-reconcile" \
  ops/linux/certbot/round-turn-deploy-hook >/dev/null

recipient_file="$fixture_dir/backup-recipients.txt"
printf 'age1testrecipient\n' >"$recipient_file"
backup_dir="$fixture_dir/backups"
PATH="$fake_bin:$PATH" ops/linux/backup-caddy.sh \
  --state-dir "$state_dir" \
  --recipient-file "$recipient_file" \
  --output-dir "$backup_dir" \
  "$env_b" \
  >/dev/null
backup_file=$(printf '%s\n' "$backup_dir"/*.tar.age)
[[ -s "$backup_file" && -s "$backup_file.sha256" ]] ||
  fail 'encrypted backup and checksum were not created'

identity_file="$fixture_dir/backup-identity.txt"
printf 'AGE-SECRET-KEY-TEST\n' >"$identity_file"
chmod 0600 "$identity_file"
touch "$fixture_dir/volumes-missing"
PATH="$fake_bin:$PATH" ops/linux/restore-caddy.sh \
  --state-dir "$state_dir" \
  --identity-file "$identity_file" \
  --confirm RESTORE_CADDY_VOLUMES \
  "$backup_file" \
  "$env_b" \
  >/dev/null
grep -Fq 'volume-create volume create' "$fixture_dir/docker.log" ||
  fail 'fresh-host restore did not create missing Compose volumes'

for script in ops/linux/*.sh ops/linux/certbot/*; do
  bash -n "$script"
done
grep -Fq 'Persistent=true' ops/linux/systemd/round-turn-certificate-reconcile.timer
grep -Fq 'OnFailure=round-ops-failure@%n.service' \
  ops/linux/systemd/round-turn-certificate-reconcile.service
grep -Fq 'TimeoutStartSec=180s' \
  ops/linux/systemd/round-turn-certificate-reconcile.service

printf 'ROUND Linux operations tests passed.\n'
