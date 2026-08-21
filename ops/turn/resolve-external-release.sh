#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'external-turn-release: %s\n' "$*" >&2
  exit 1
}

if (( $# != 1 )); then
  fail 'usage: resolve-external-release.sh <release-tag>'
fi

release_tag=$1
github_sha=${GITHUB_SHA:-}
[[ -n "$github_sha" ]] || fail 'GITHUB_SHA is required'

if [[ ! "$release_tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
  fail 'release tag must be SemVer without build metadata'
fi
if [[ "$release_tag" == *-* ]]; then
  prerelease=${release_tag#*-}
  IFS='.' read -r -a prerelease_identifiers <<<"$prerelease"
  for identifier in "${prerelease_identifiers[@]}"; do
    if [[ "$identifier" =~ ^[0-9]+$ && "$identifier" == 0[0-9]* ]]; then
      fail "numeric SemVer prerelease identifiers must not contain leading zeroes: $identifier"
    fi
  done
fi

tag_ref=refs/tags/$release_tag
tag_object_sha=$(git rev-parse "${tag_ref}^{tag}" 2>/dev/null) ||
  fail "release tag must exist and be annotated: $release_tag"

release_sha=$(git rev-parse "${tag_ref}^{commit}")
if ! git merge-base --is-ancestor "$release_sha" "$github_sha"; then
  fail 'release tag is not reachable from the dispatched default-branch commit'
fi

printf 'release_sha=%s\n' "$release_sha"
printf 'tag_object_sha=%s\n' "$tag_object_sha"
