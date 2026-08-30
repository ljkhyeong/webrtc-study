#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"
fixture_dir=$(mktemp -d)
cleanup() {
  rm -rf -- "$fixture_dir"
}
trap cleanup EXIT

fake_bin="$fixture_dir/bin"
state_dir="$fixture_dir/state"
mkdir -p "$fake_bin" "$state_dir"

cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

reference_key() {
  printf '%s' "$1" | tr '/:@' '____'
}

if [[ "${1:-}" != buildx || "${2:-}" != imagetools ]]; then
  printf '지원하지 않는 fake docker 호출입니다: %s\n' "$*" >&2
  exit 2
fi

case "${3:-}" in
  inspect)
    reference="${4:-}"
    if [[ "$reference" == *@sha256:* ]]; then
      printf '%s\n' "${reference##*@}"
      exit 0
    fi
    state_file="$PROMOTION_STATE_DIR/$(reference_key "$reference")"
    if [[ -f "$state_file" ]]; then
      cat "$state_file"
      exit 0
    fi
    printf 'manifest unknown: %s\n' "$reference" >&2
    exit 1
    ;;
  create)
    [[ "${4:-}" == --tag ]] || exit 2
    tag="${5:-}"
    source_reference="${6:-}"
    if [[ -n "${FAIL_TAG_ONCE:-}" && "$tag" == "$FAIL_TAG_ONCE" ]]; then
      marker="$PROMOTION_STATE_DIR/failure-triggered"
      if [[ ! -e "$marker" ]]; then
        touch "$marker"
        printf 'forced create failure: %s\n' "$tag" >&2
        exit 1
      fi
    fi
    printf '%s\n' "${source_reference##*@}" \
      >"$PROMOTION_STATE_DIR/$(reference_key "$tag")"
    printf 'create %s\n' "$tag" >>"$PROMOTION_LOG"
    ;;
  *)
    exit 2
    ;;
esac
EOF
chmod +x "$fake_bin/docker"

reference_key() {
  printf '%s' "$1" | tr '/:@' '____'
}

digest_a="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
digest_b="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
source_a="registry.invalid/round-edge@$digest_a"
source_b="registry.invalid/round-signaling@$digest_b"
tag_a1="registry.invalid/round-edge:v1"
tag_a2="registry.invalid/round-edge:sha-a"
tag_b1="registry.invalid/round-signaling:v1"
tag_b2="registry.invalid/round-signaling:sha-b"
promotion_log="$fixture_dir/promotions.log"
touch "$promotion_log"

export PROMOTION_STATE_DIR="$state_dir"
export PROMOTION_LOG="$promotion_log"
export PATH="$fake_bin:$PATH"
export FAIL_TAG_ONCE="$tag_b1"

if ops/ci/promote-image-tags.sh \
  "$source_a" "$tag_a1" "$tag_a2" \
  "$source_b" "$tag_b1" "$tag_b2"; then
  printf '중간 승격 실패를 재현하지 못했습니다.\n' >&2
  exit 1
fi

ops/ci/promote-image-tags.sh \
  "$source_a" "$tag_a1" "$tag_a2" \
  "$source_b" "$tag_b1" "$tag_b2"

for tag in "$tag_a1" "$tag_a2" "$tag_b1" "$tag_b2"; do
  if [[ "$(grep -Fc "create $tag" "$promotion_log")" != 1 ]]; then
    printf '재시도 중 태그를 중복 생성했습니다: %s\n' "$tag" >&2
    exit 1
  fi
done

wrong_tag="registry.invalid/round-edge:wrong"
new_tag="registry.invalid/round-edge:new"
printf '%s\n' "$digest_b" >"$state_dir/$(reference_key "$wrong_tag")"
if ops/ci/promote-image-tags.sh "$source_a" "$wrong_tag" "$new_tag"; then
  printf '다른 digest의 기존 태그를 수용했습니다.\n' >&2
  exit 1
fi
if [[ -e "$state_dir/$(reference_key "$new_tag")" ]]; then
  printf '호환성 사전 검사 실패 전에 새 태그를 만들었습니다.\n' >&2
  exit 1
fi

printf '이미지 태그 승격 재시도 계약 검사를 통과했습니다.\n'
