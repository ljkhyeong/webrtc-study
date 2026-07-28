#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s <dns-hostname> <port> [ca-file]\n' "${0##*/}" >&2
}

if (( $# < 2 || $# > 3 )); then
  usage
  exit 2
fi

host=$1
port=$2
ca_file=${3:-}

case "$host" in
  '' | -* | *[!A-Za-z0-9.-]*)
    printf 'round-turn-tls-check: host must be a DNS hostname\n' >&2
    exit 2
    ;;
esac
if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  printf 'round-turn-tls-check: port must be between 1 and 65535\n' >&2
  exit 2
fi
if [[ -n "$ca_file" && ! -r "$ca_file" ]]; then
  printf 'round-turn-tls-check: CA file must be readable\n' >&2
  exit 2
fi
if ! command -v openssl >/dev/null 2>&1; then
  printf 'round-turn-tls-check: openssl is required\n' >&2
  exit 2
fi

openssl_args=(
  s_client
  -connect "${host}:${port}"
  -servername "$host"
  -verify_hostname "$host"
  -verify_return_error
)
if [[ -n "$ca_file" ]]; then
  openssl_args+=(-CAfile "$ca_file")
fi

exec openssl "${openssl_args[@]}" </dev/null
