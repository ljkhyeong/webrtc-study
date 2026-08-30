#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
사용법: ops/ci/promote-image-tags.sh SOURCE_DIGEST TAG TAG [SOURCE_DIGEST TAG TAG ...]

각 source digest를 두 최종 태그로 승격합니다. 기존 태그가 같은 digest면 재사용하고,
다른 digest면 덮어쓰지 않고 실패합니다.
EOF
}

if (( $# == 0 || $# % 3 != 0 )); then
  usage >&2
  exit 2
fi

is_missing_manifest() {
  grep -Eqi '(manifest unknown|name unknown|(^|: )not found([[:space:]]|$))'
}

inspect_digest() {
  docker buildx imagetools inspect "$1" --format '{{.Manifest.Digest}}'
}

declare -a sources=()
declare -a tags=()
declare -a expected_digests=()
declare -a missing=()

while (( $# > 0 )); do
  source_reference="$1"
  first_tag="$2"
  second_tag="$3"
  shift 3

  if [[ ! "$source_reference" =~ @sha256:[0-9a-f]{64}$ ]]; then
    printf '승격 source는 sha256 digest로 고정해야 합니다: %s\n' "$source_reference" >&2
    exit 1
  fi
  expected_digest="${source_reference##*@}"
  source_digest="$(inspect_digest "$source_reference")"
  if [[ "$source_digest" != "$expected_digest" ]]; then
    printf '승격 source %s의 실제 digest는 %s이며 예상값은 %s입니다.\n' \
      "$source_reference" "$source_digest" "$expected_digest" >&2
    exit 1
  fi

  for tag in "$first_tag" "$second_tag"; do
    if inspect_output="$(inspect_digest "$tag" 2>&1)"; then
      if [[ "$inspect_output" != "$expected_digest" ]]; then
        printf '기존 최종 태그 %s의 digest는 %s이며 예상값은 %s입니다. 덮어쓰지 않습니다.\n' \
          "$tag" "$inspect_output" "$expected_digest" >&2
        exit 1
      fi
      tag_missing=false
    elif is_missing_manifest <<<"$inspect_output"; then
      tag_missing=true
    else
      printf '최종 태그 %s의 상태를 확인하지 못했습니다.\n%s\n' \
        "$tag" "$inspect_output" >&2
      exit 1
    fi

    sources+=("$source_reference")
    tags+=("$tag")
    expected_digests+=("$expected_digest")
    missing+=("$tag_missing")
  done
done

for index in "${!tags[@]}"; do
  tag="${tags[$index]}"
  expected_digest="${expected_digests[$index]}"
  if [[ "${missing[$index]}" == false ]]; then
    printf '이미 올바른 digest로 승격된 태그를 재사용합니다: %s\n' "$tag"
    continue
  fi

  docker buildx imagetools create \
    --tag "$tag" \
    "${sources[$index]}"

  actual_digest="$(inspect_digest "$tag")"
  if [[ "$actual_digest" != "$expected_digest" ]]; then
    printf '승격 직후 태그 %s의 실제 digest는 %s이며 예상값은 %s입니다.\n' \
      "$tag" "$actual_digest" "$expected_digest" >&2
    exit 1
  fi
  printf '이미지 태그를 승격하고 digest를 확인했습니다: %s\n' "$tag"
done
