#!/bin/sh
set -eu

fail() {
  printf 'round-turn: %s\n' "$*" >&2
  exit 1
}

required() {
  variable_name=$1
  variable_value=$2
  [ -n "$variable_value" ] || fail "$variable_name is required"
}

required TURN_EXTERNAL_IP "${TURN_EXTERNAL_IP:-}"
required TURN_RELAY_IP "${TURN_RELAY_IP:-}"
required TURN_REALM "${TURN_REALM:-}"
required TURN_SHARED_SECRET "${TURN_SHARED_SECRET:-}"
required TURN_URLS "${TURN_URLS:-}"
required TURN_MIN_PORT "${TURN_MIN_PORT:-}"
required TURN_MAX_PORT "${TURN_MAX_PORT:-}"
required TURN_USER_QUOTA "${TURN_USER_QUOTA:-}"
required TURN_TOTAL_QUOTA "${TURN_TOTAL_QUOTA:-}"
required TURN_MAX_BPS "${TURN_MAX_BPS:-}"
required TURN_BPS_CAPACITY "${TURN_BPS_CAPACITY:-}"

case "$TURN_EXTERNAL_IP:$TURN_RELAY_IP" in
  *[!0-9.:]*) fail "TURN_EXTERNAL_IP and TURN_RELAY_IP must be IPv4 addresses" ;;
esac

case "$TURN_REALM" in
  *[!A-Za-z0-9.-]*) fail "TURN_REALM must be a DNS name" ;;
esac

case "$TURN_SHARED_SECRET" in
  *[!A-Fa-f0-9]*) fail "TURN_SHARED_SECRET must be hexadecimal" ;;
esac
[ "${#TURN_SHARED_SECRET}" -ge 64 ] \
  || fail "TURN_SHARED_SECRET must contain at least 64 hexadecimal characters"

case "$TURN_MIN_PORT:$TURN_MAX_PORT" in
  *[!0-9:]*) fail "TURN_MIN_PORT and TURN_MAX_PORT must be integers" ;;
esac
[ "$TURN_MIN_PORT" -ge 1024 ] || fail "TURN_MIN_PORT must be at least 1024"
[ "$TURN_MAX_PORT" -le 65535 ] || fail "TURN_MAX_PORT must be at most 65535"
[ "$TURN_MIN_PORT" -le "$TURN_MAX_PORT" ] \
  || fail "TURN_MIN_PORT must not exceed TURN_MAX_PORT"

case "$TURN_USER_QUOTA:$TURN_TOTAL_QUOTA:$TURN_MAX_BPS:$TURN_BPS_CAPACITY" in
  *[!0-9:]*) fail "TURN quota and bandwidth values must be integers" ;;
esac
[ "$TURN_USER_QUOTA" -gt 0 ] || fail "TURN_USER_QUOTA must be positive"
[ "$TURN_TOTAL_QUOTA" -ge "$TURN_USER_QUOTA" ] \
  || fail "TURN_TOTAL_QUOTA must be at least TURN_USER_QUOTA"
[ "$TURN_MAX_BPS" -gt 0 ] || fail "TURN_MAX_BPS must be positive"
[ "$TURN_BPS_CAPACITY" -ge "$TURN_MAX_BPS" ] \
  || fail "TURN_BPS_CAPACITY must be at least TURN_MAX_BPS"

tls_cert=/run/secrets/turn_tls_cert.pem
tls_key=/run/secrets/turn_tls_key.pem
[ -r "$tls_cert" ] || fail "TURN TLS certificate is not readable at $tls_cert"
[ -r "$tls_key" ] || fail "TURN TLS private key is not readable at $tls_key"

runtime_config=/tmp/round-turnserver.conf
umask 077
cat /etc/coturn/round-turnserver.conf >"$runtime_config"

{
  printf 'realm=%s\n' "$TURN_REALM"
  printf 'server-name=%s\n' "$TURN_REALM"
  printf 'relay-ip=%s\n' "$TURN_RELAY_IP"
  if [ "$TURN_EXTERNAL_IP" = "$TURN_RELAY_IP" ]; then
    printf 'external-ip=%s\n' "$TURN_EXTERNAL_IP"
  else
    printf 'external-ip=%s/%s\n' "$TURN_EXTERNAL_IP" "$TURN_RELAY_IP"
  fi
  printf 'min-port=%s\n' "$TURN_MIN_PORT"
  printf 'max-port=%s\n' "$TURN_MAX_PORT"
  printf 'user-quota=%s\n' "$TURN_USER_QUOTA"
  printf 'total-quota=%s\n' "$TURN_TOTAL_QUOTA"
  printf 'max-bps=%s\n' "$TURN_MAX_BPS"
  printf 'bps-capacity=%s\n' "$TURN_BPS_CAPACITY"
  printf 'cert=%s\n' "$tls_cert"
  printf 'pkey=%s\n' "$tls_key"
  printf 'static-auth-secret=%s\n' "$TURN_SHARED_SECRET"
} >>"$runtime_config"

exec /usr/bin/turnserver -c "$runtime_config"
