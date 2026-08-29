#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
  printf '검사할 이미지 태그를 한 개 이상 전달해야 합니다.\n' >&2
  exit 2
fi

for reference in "$@"; do
  if inspect_output=$(docker buildx imagetools inspect "$reference" 2>&1); then
    printf '기존 이미지 태그를 덮어쓰지 않습니다: %s\n' "$reference" >&2
    exit 1
  fi
  if grep -Eqi '(manifest unknown|name unknown|(^|: )not found([[:space:]]|$))' <<< "$inspect_output"; then
    printf '미사용 이미지 태그를 확인했습니다: %s\n' "$reference"
    continue
  fi

  printf '이미지 태그가 미사용 상태임을 증명하지 못했습니다: %s\n%s\n' \
    "$reference" "$inspect_output" >&2
  exit 1
done
