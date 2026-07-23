#!/usr/bin/env bash
set -euo pipefail

dry_run=false
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
elif [[ $# -gt 0 ]]; then
  printf 'usage: %s [--dry-run]\n' "$0" >&2
  exit 2
fi

latest_tag=$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n1)
if [[ -z "$latest_tag" ]]; then
  latest_tag=v0.0.0
  range=HEAD
else
  range="${latest_tag}..HEAD"
fi

IFS=. read -r major minor patch <<< "${latest_tag#v}"
bump=
breaking_subject='^[a-z]+(\([^)]*\))?!:'
feature_subject='^feat(\([^)]*\))?:'
fix_subject='^fix(\([^)]*\))?:'

while IFS= read -r subject; do
  if [[ "$subject" =~ $breaking_subject ]] \
    || [[ "$subject" == BREAKING\ CHANGE:* ]]; then
    bump=major
    break
  elif [[ "$subject" =~ $feature_subject ]]; then
    [[ "$bump" == major ]] || bump=minor
  elif [[ "$subject" =~ $fix_subject ]]; then
    [[ -n "$bump" ]] || bump=patch
  fi
done < <(git log "$range" --format='%s%n%b')

if [[ -z "$bump" ]]; then
  printf 'No release required after %s.\n' "$latest_tag"
  exit 0
fi

case "$bump" in
  major) major=$((major + 1)); minor=0; patch=0 ;;
  minor) minor=$((minor + 1)); patch=0 ;;
  patch) patch=$((patch + 1)) ;;
esac

next_tag="v${major}.${minor}.${patch}"
printf '%s fork release: %s -> %s\n' "$bump" "$latest_tag" "$next_tag"

if [[ "$dry_run" == false ]]; then
  git tag -a "$next_tag" -m "$next_tag"
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'tag=%s\n' "$next_tag" >> "$GITHUB_OUTPUT"
fi
