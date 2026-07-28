#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
tls_verifier=$repo_root/ops/turn/verify-tls.sh

fail() {
  printf 'TURN TLS verification regression: %s\n' "$*" >&2
  exit 1
}

command -v openssl >/dev/null 2>&1 || fail "openssl is required"

fixture_dir=$(mktemp -d)
server_pid=
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$fixture_dir"
}
trap cleanup EXIT
umask 077

create_ca() {
  local name=$1
  openssl req \
    -x509 \
    -newkey rsa:2048 \
    -nodes \
    -days 1 \
    -subj "/CN=ROUND ${name} test CA" \
    -addext 'basicConstraints=critical,CA:TRUE' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -keyout "$fixture_dir/${name}-ca-key.pem" \
    -out "$fixture_dir/${name}-ca-cert.pem" \
    >/dev/null 2>&1
}

create_server_certificate() {
  local name=$1
  local common_name=$2
  local ca_name=$3

  openssl req \
    -new \
    -newkey rsa:2048 \
    -nodes \
    -subj "/CN=${common_name}" \
    -keyout "$fixture_dir/${name}-key.pem" \
    -out "$fixture_dir/${name}.csr" \
    >/dev/null 2>&1
  printf '%s\n' \
    "subjectAltName=DNS:${common_name}" \
    'basicConstraints=critical,CA:FALSE' \
    'keyUsage=critical,digitalSignature,keyEncipherment' \
    'extendedKeyUsage=serverAuth' \
    >"$fixture_dir/${name}-extensions.cnf"
  openssl x509 \
    -req \
    -days 1 \
    -in "$fixture_dir/${name}.csr" \
    -CA "$fixture_dir/${ca_name}-ca-cert.pem" \
    -CAkey "$fixture_dir/${ca_name}-ca-key.pem" \
    -CAcreateserial \
    -extfile "$fixture_dir/${name}-extensions.cnf" \
    -out "$fixture_dir/${name}-cert.pem" \
    >/dev/null 2>&1
}

stop_server() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
    server_pid=
  fi
}

start_server() {
  local name=$1
  local attempt
  local candidate_port

  stop_server
  for attempt in {0..9}; do
    candidate_port=$((20000 + (($$ + attempt * 997) % 30000)))
    openssl s_server \
      -quiet \
      -accept "$candidate_port" \
      -cert "$fixture_dir/${name}-cert.pem" \
      -key "$fixture_dir/${name}-key.pem" \
      -www \
      >"$fixture_dir/${name}-server.log" 2>&1 &
    server_pid=$!
    sleep 0.2
    if kill -0 "$server_pid" >/dev/null 2>&1; then
      server_port=$candidate_port
      return
    fi
    wait "$server_pid" >/dev/null 2>&1 || true
    server_pid=
  done

  if [[ -s "$fixture_dir/${name}-server.log" ]]; then
    sed -n '1,10p' "$fixture_dir/${name}-server.log" >&2
  fi
  fail "could not start a local TLS fixture server"
}

create_ca trusted
create_ca unrelated
create_server_certificate correct localhost trusted
create_server_certificate wrong-host turn.invalid trusted

start_server correct
if ! bash "$tls_verifier" \
  localhost "$server_port" "$fixture_dir/trusted-ca-cert.pem" \
  >/dev/null 2>&1; then
  fail "a trusted certificate for the requested hostname was rejected"
fi
if bash "$tls_verifier" \
  localhost "$server_port" "$fixture_dir/unrelated-ca-cert.pem" \
  >/dev/null 2>&1; then
  fail "an untrusted certificate chain was accepted"
fi

start_server wrong-host
if bash "$tls_verifier" \
  localhost "$server_port" "$fixture_dir/trusted-ca-cert.pem" \
  >/dev/null 2>&1; then
  fail "a certificate for a different hostname was accepted"
fi

printf 'TURN TLS chain and hostname regression checks passed.\n'
