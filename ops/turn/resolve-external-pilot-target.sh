#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'external-turn-target: %s\n' "$*" >&2
  exit 1
}

if (( $# != 1 )); then
  fail 'usage: resolve-external-pilot-target.sh <target-properties-file>'
fi

target_file=$1
[[ -f "$target_file" && -r "$target_file" ]] \
  || fail 'target properties must be a readable regular file'

round_url=
turn_host=
probe_image=
round_url_count=0
turn_host_count=0
probe_image_count=0

while IFS= read -r line || [[ -n "$line" ]]; do
  line=${line%$'\r'}
  case "$line" in
    '' | \#*)
      continue
      ;;
  esac

  if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=([^[:space:]]+)$ ]]; then
    fail 'target properties contain an invalid line'
  fi

  key=${BASH_REMATCH[1]}
  value=${BASH_REMATCH[2]}
  case "$key" in
    ROUND_URL)
      round_url=$value
      ((round_url_count += 1))
      ;;
    TURN_PROBE_HOST)
      turn_host=$value
      ((turn_host_count += 1))
      ;;
    TURN_PROBE_IMAGE)
      probe_image=$value
      ((probe_image_count += 1))
      ;;
    *)
      fail "unexpected target property: $key"
      ;;
  esac
done <"$target_file"

(( round_url_count == 1 )) || fail 'target properties must contain ROUND_URL exactly once'
(( turn_host_count == 1 )) \
  || fail 'target properties must contain TURN_PROBE_HOST exactly once'
(( probe_image_count == 1 )) \
  || fail 'target properties must contain TURN_PROBE_IMAGE exactly once'

if [[ ! "$round_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
  fail 'ROUND_URL must be an exact HTTPS origin'
fi
case "$turn_host" in
  '' | -* | *[!A-Za-z0-9.-]*)
    fail 'TURN_PROBE_HOST must be a plain host'
    ;;
esac
if [[ ! "$probe_image" =~ ^coturn/coturn@sha256:[0-9a-f]{64}$ ]]; then
  fail 'TURN_PROBE_IMAGE must pin the reviewed coturn/coturn repository'
fi

round_authority=${round_url#https://}
round_host=${round_authority%%:*}
round_host=${round_host%.}
normalized_round_host=$(printf '%s' "$round_host" | tr '[:upper:]' '[:lower:]')
normalized_turn_host=$(printf '%s' "${turn_host%.}" | tr '[:upper:]' '[:lower:]')
case "$normalized_round_host" in
  example | *.example | example.com | *.example.com)
    fail 'replace the reserved example ROUND host through a reviewed pull request'
    ;;
esac
case "$normalized_turn_host" in
  example | *.example | example.com | *.example.com)
    fail 'replace the reserved example TURN host through a reviewed pull request'
    ;;
esac

printf 'round_url=%s\n' "$round_url"
printf 'turn_host=%s\n' "$turn_host"
printf 'probe_image=%s\n' "$probe_image"
