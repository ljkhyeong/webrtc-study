#!/usr/bin/env bash
set -Eeuo pipefail

if (( $# != 1 )); then
  printf 'Usage: %s BASE_URL\n' "${0##*/}" >&2
  exit 2
fi

base_url=${1%/}
case "$base_url" in
  http://* | https://*)
    ;;
  *)
    printf 'BATON web verification: BASE_URL must be HTTP or HTTPS\n' >&2
    exit 2
    ;;
esac

command -v curl >/dev/null 2>&1 || {
  printf 'BATON web verification: curl is required\n' >&2
  exit 1
}
command -v node >/dev/null 2>&1 || {
  printf 'BATON web verification: node is required\n' >&2
  exit 1
}

fixture_dir=$(mktemp -d)
cleanup() {
  rm -rf -- "$fixture_dir"
}
trap cleanup EXIT

fail() {
  printf 'BATON web verification: %s\n' "$*" >&2
  exit 1
}

request() {
  local name=$1
  local path=$2
  local expected_status=$3
  local status

  status=$(
    curl \
      --silent \
      --show-error \
      --dump-header "$fixture_dir/$name.headers" \
      --output "$fixture_dir/$name.body" \
      --write-out '%{http_code}' \
      "$base_url$path"
  )
  [[ "$status" == "$expected_status" ]] ||
    fail "$path returned HTTP $status; expected $expected_status"
}

cache_control() {
  local name=$1
  awk '
    BEGIN { IGNORECASE = 1 }
    $1 == "Cache-Control:" {
      sub(/^[^:]+:[[:space:]]*/, "")
      sub(/\r$/, "")
      value = $0
    }
    END { print value }
  ' "$fixture_dir/$name.headers"
}

assert_cache_control() {
  local name=$1
  local expected=$2
  local actual

  actual=$(cache_control "$name")
  [[ "$actual" == "$expected" ]] ||
    fail "$name Cache-Control was '$actual'; expected '$expected'"
}

request room_html /room/abcd-efgh-jkmp 200
assert_cache_control room_html no-store
grep -Fq '<div id="root"></div>' "$fixture_dir/room_html.body" ||
  fail '/room/* did not serve the BATON browser HTML'

asset_path=$(
  node -e '
    const html = require("node:fs").readFileSync(process.argv[1], "utf8");
    const match = html.match(/(?:src|href)="(\/round-ui\/assets\/[^"]+)"/);
    if (!match) process.exit(1);
    process.stdout.write(match[1]);
  ' "$fixture_dir/room_html.body"
) || fail 'room HTML did not reference a /round-ui/assets/* artifact'

[[ "$asset_path" =~ ^/round-ui/assets/([^/]+/)*[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+$ ]] ||
  fail "room HTML referenced an asset without a Vite content hash: $asset_path"

request hashed_asset "$asset_path" 200
assert_cache_control hashed_asset 'public, max-age=31536000, immutable'
[[ -s "$fixture_dir/hashed_asset.body" ]] || fail "$asset_path returned an empty body"

request missing_hashed_asset /round-ui/assets/missing-AAAAAAAA.js 404
assert_cache_control missing_hashed_asset no-store

request non_hashed_asset /round-ui/assets/index.js 404
assert_cache_control non_hashed_asset no-store

request asset_root /round-ui/ 404
assert_cache_control asset_root no-store

printf 'BATON web runtime HTTP contract passed.\n'
