#!/usr/bin/env bash
set -euo pipefail

dry_run=false
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
elif [[ $# -gt 0 ]]; then
  printf 'usage: %s [--dry-run]\n' "$0" >&2
  exit 2
fi

tag_pattern='career-ops-v[0-9]*.[0-9]*.[0-9]*'
source_version=$(sed -E 's/[[:space:]]*#.*$//' VERSION | tr -d '[:space:]')
package_version=$(node -p "require('./package.json').version")
scaffolder_version=$(node -p "require('./scaffolder/package.json').version")
manifest_version=$(node -p "require('./.release-please-manifest.json')['.']")

if [[ ! "$source_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'Invalid source version in VERSION: %s\n' "$source_version" >&2
  exit 1
fi

for aligned_version in "$package_version" "$scaffolder_version" "$manifest_version"; do
  if [[ "$aligned_version" != "$source_version" ]]; then
    printf 'Release version files are not aligned: VERSION=%s, observed=%s\n' \
      "$source_version" "$aligned_version" >&2
    exit 1
  fi
done

next_tag="career-ops-v${source_version}"
tag_commit=$(git rev-list -n1 "$next_tag" 2>/dev/null || true)
if [[ -n "$tag_commit" ]]; then
  if [[ "$tag_commit" == "$(git rev-parse HEAD)" ]]; then
    printf 'Release tag already points at HEAD: %s\n' "$next_tag"
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
      printf 'tag=%s\n' "$next_tag" >> "$GITHUB_OUTPUT"
    fi
    exit 0
  fi

  if git merge-base --is-ancestor "$tag_commit" HEAD; then
    printf 'Source version already released: %s\n' "$next_tag"
    exit 0
  fi

  printf 'Release tag exists outside the current lineage: %s\n' "$next_tag" >&2
  exit 1
fi

version_is_greater() {
  local left_major left_minor left_patch right_major right_minor right_patch
  IFS=. read -r left_major left_minor left_patch <<< "$1"
  IFS=. read -r right_major right_minor right_patch <<< "$2"

  if (( 10#$left_major != 10#$right_major )); then
    (( 10#$left_major > 10#$right_major ))
    return
  fi
  if (( 10#$left_minor != 10#$right_minor )); then
    (( 10#$left_minor > 10#$right_minor ))
    return
  fi
  (( 10#$left_patch > 10#$right_patch ))
}

latest_tag=$(git tag --merged HEAD --list "$tag_pattern" --sort=-v:refname | head -n1)
if [[ -n "$latest_tag" ]] \
  && ! version_is_greater "$source_version" "${latest_tag#career-ops-v}"; then
  printf 'Source version %s does not advance reachable release %s\n' \
    "$source_version" "$latest_tag" >&2
  exit 1
fi

printf 'source release: %s -> %s\n' "${latest_tag:-none}" "$next_tag"

if [[ "$dry_run" == false ]]; then
  git tag -a "$next_tag" -m "$next_tag"
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'tag=%s\n' "$next_tag" >> "$GITHUB_OUTPUT"
fi
