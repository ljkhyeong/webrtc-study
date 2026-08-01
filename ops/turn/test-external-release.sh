#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
resolver=$repo_root/ops/turn/resolve-external-release.sh
test_root=$(mktemp -d)
git_root=$test_root/repository

cleanup() {
  rm -rf -- "$test_root"
}
trap cleanup EXIT

fail() {
  printf 'external-turn-release-test: %s\n' "$*" >&2
  exit 1
}

assert_rejected() {
  local tag=$1
  local sha=$2
  local label=$3
  if (
    cd "$git_root"
    GITHUB_SHA=$sha bash "$resolver" "$tag" >/dev/null 2>&1
  ); then
    fail "$label"
  fi
}

mkdir -m 0700 -- "$git_root"
git -C "$git_root" init --quiet
git -C "$git_root" config user.email round-ci@example.invalid
git -C "$git_root" config user.name 'ROUND CI'
printf 'first\n' >"$git_root/evidence.txt"
git -C "$git_root" add evidence.txt
git -C "$git_root" commit --quiet -m first
release_sha=$(git -C "$git_root" rev-parse HEAD)
git -C "$git_root" tag -a v1.2.3 -m 'release v1.2.3'
tag_object_sha=$(git -C "$git_root" rev-parse refs/tags/v1.2.3)
git -C "$git_root" tag v1.2.4

printf 'second\n' >>"$git_root/evidence.txt"
git -C "$git_root" add evidence.txt
git -C "$git_root" commit --quiet -m second
dispatch_sha=$(git -C "$git_root" rev-parse HEAD)
tree_sha=$(git -C "$git_root" write-tree)
unrelated_sha=$(printf 'unrelated\n' | git -C "$git_root" commit-tree "$tree_sha")

actual=$(
  cd "$git_root"
  GITHUB_SHA=$dispatch_sha bash "$resolver" v1.2.3
)
expected=$(printf '%s\n' \
  "release_sha=$release_sha" \
  "tag_object_sha=$tag_object_sha")
[[ "$actual" == "$expected" ]] || fail 'annotated release outputs were not exact'

assert_rejected v1.2.4 "$dispatch_sha" 'lightweight tag was accepted'
assert_rejected release-1 "$dispatch_sha" 'malformed release tag was accepted'
assert_rejected v1.2.3-01 "$dispatch_sha" 'numeric prerelease leading zero was accepted'
assert_rejected v1.2.3 "$unrelated_sha" 'unreachable dispatch commit was accepted'

printf 'External TURN release reference checks passed.\n'
