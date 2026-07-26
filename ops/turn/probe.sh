#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: ROUND_URL=https://round.example.com \
       TURN_PROBE_HOST=turn.example.com \
       ops/turn/probe.sh

Fetches a fresh short-lived TURN credential over HTTPS, then creates
authenticated client-to-client relay traffic through each configured transport.

Optional environment variables:
  TURN_PROBE_TRANSPORTS       Comma-separated udp,tcp,tls (default: udp,tcp,tls)
  TURN_PROBE_UDP_PORT         TURN UDP/TCP listener (default: 3478)
  TURN_PROBE_TLS_PORT         TURN TLS listener (default: 5349)
  TURN_PROBE_TIMEOUT_SECONDS  Per-transport timeout (default: 20)
  TURN_PROBE_IMAGE            Coturn utility image (default: deployment image)
EOF
}

case "${1:-}" in
  '')
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

fail() {
  printf 'round-turn-probe: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

require_command curl
require_command docker
require_command jq
require_command timeout

round_url=${ROUND_URL:-}
turn_host=${TURN_PROBE_HOST:-}
transport_list=${TURN_PROBE_TRANSPORTS:-udp,tcp,tls}
udp_port=${TURN_PROBE_UDP_PORT:-3478}
tls_port=${TURN_PROBE_TLS_PORT:-5349}
probe_timeout=${TURN_PROBE_TIMEOUT_SECONDS:-20}
probe_image=${TURN_PROBE_IMAGE:-coturn/coturn:4.14.0-r0-alpine}

[[ "$round_url" == https://* ]] || fail "ROUND_URL must use https://"
case "$turn_host" in
  '' | -* | *[!A-Za-z0-9.-]*)
    fail "TURN_PROBE_HOST must be a DNS hostname"
    ;;
esac

validate_port() {
  local name=$1
  local value=$2
  [[ "$value" =~ ^[0-9]+$ ]] || fail "$name must be an integer"
  (( value >= 1 && value <= 65535 )) || fail "$name must be between 1 and 65535"
}

validate_port TURN_PROBE_UDP_PORT "$udp_port"
validate_port TURN_PROBE_TLS_PORT "$tls_port"
[[ "$probe_timeout" =~ ^[1-9][0-9]*$ ]] \
  || fail "TURN_PROBE_TIMEOUT_SECONDS must be a positive integer"

credential_file=$(mktemp)
cleanup() {
  rm -f -- "$credential_file"
}
trap cleanup EXIT
umask 077

credential_url=${round_url%/}/api/turn-credentials
curl \
  --fail \
  --silent \
  --show-error \
  --connect-timeout 5 \
  --max-time 10 \
  --output "$credential_file" \
  "$credential_url" \
  || fail "credential endpoint request failed"

username=$(jq -er '.username | strings | select(length > 0)' "$credential_file") \
  || fail "credential response has no username"
credential=$(jq -er '.credential | strings | select(length > 0)' "$credential_file") \
  || fail "credential response has no credential"
expires_at=$(jq -er '.expiresAt | numbers | floor' "$credential_file") \
  || fail "credential response has no numeric expiresAt"

now=$(date +%s)
(( expires_at > now + 60 )) || fail "credential expires too soon"

export TURN_PROBE_USERNAME=$username
export TURN_PROBE_CREDENTIAL=$credential
export TURN_PROBE_HOST=$turn_host

probe_transport() {
  local transport=$1
  local expected_url
  local port

  case "$transport" in
    udp)
      expected_url="turn:$turn_host:$udp_port?transport=udp"
      port=$udp_port
      ;;
    tcp)
      expected_url="turn:$turn_host:$udp_port?transport=tcp"
      port=$udp_port
      ;;
    tls)
      expected_url="turns:$turn_host:$tls_port?transport=tcp"
      port=$tls_port
      ;;
    *)
      fail "unsupported transport: $transport"
      ;;
  esac

  jq -e --arg expected "$expected_url" \
    '.urls | arrays | index($expected) != null' \
    "$credential_file" >/dev/null \
    || fail "credential response does not advertise the $transport transport"

  export TURN_PROBE_PORT=$port
  export TURN_PROBE_TRANSPORT=$transport

  if ! timeout "${probe_timeout}s" docker run --rm \
    -e TURN_PROBE_CREDENTIAL \
    -e TURN_PROBE_HOST \
    -e TURN_PROBE_PORT \
    -e TURN_PROBE_TRANSPORT \
    -e TURN_PROBE_USERNAME \
    --entrypoint /bin/sh \
    "$probe_image" \
    -eu -c '
      case "$TURN_PROBE_TRANSPORT" in
        udp)
          exec /usr/bin/turnutils_uclient \
            -y -c -n 1 -p "$TURN_PROBE_PORT" \
            -u "$TURN_PROBE_USERNAME" -w "$TURN_PROBE_CREDENTIAL" \
            "$TURN_PROBE_HOST"
          ;;
        tcp)
          exec /usr/bin/turnutils_uclient \
            -t -y -c -n 1 -p "$TURN_PROBE_PORT" \
            -u "$TURN_PROBE_USERNAME" -w "$TURN_PROBE_CREDENTIAL" \
            "$TURN_PROBE_HOST"
          ;;
        tls)
          exec /usr/bin/turnutils_uclient \
            -t -S -y -c -n 1 -p "$TURN_PROBE_PORT" \
            -E /etc/ssl/certs/ca-certificates.crt \
            -u "$TURN_PROBE_USERNAME" -w "$TURN_PROBE_CREDENTIAL" \
            "$TURN_PROBE_HOST"
          ;;
      esac
    ' >/dev/null 2>&1; then
    fail "$transport authenticated relay probe failed"
  fi

  printf 'TURN probe passed: %s\n' "$transport"
}

IFS=',' read -r -a transports <<<"$transport_list"
(( ${#transports[@]} > 0 )) || fail "TURN_PROBE_TRANSPORTS must not be empty"

for transport in "${transports[@]}"; do
  [[ -n "$transport" ]] || fail "TURN_PROBE_TRANSPORTS contains an empty value"
  probe_transport "$transport"
done

printf 'TURN authenticated relay probe passed for every requested transport.\n'
