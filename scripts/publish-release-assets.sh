#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

tag="${1:-}"
if [[ -z "${tag}" ]]; then
  echo "release-assets: FAIL (usage: $0 <tag>)" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "release-assets: FAIL (gh not found)" >&2
  exit 1
fi

remote="${GIT_REMOTE:-origin}"
main_branch="${MAIN_BRANCH:-main}"
premain_branch="${PREMAIN_BRANCH:-premain}"

git fetch "${remote}" "${main_branch}" "${premain_branch}" --tags --force

release_exists=false
if gh release view "${tag}" >/dev/null 2>&1; then
  release_exists=true
fi

if [[ "${release_exists}" != "true" ]]; then
  if ! git show-ref --verify --quiet "refs/tags/${tag}"; then
    echo "release-assets: FAIL (${tag} has no release and no git tag; refusing to create a tag from a branch default)" >&2
    exit 1
  fi

  # Source code zip/tar is auto-attached by GitHub. Framework assets are uploaded below.
  gh release create "${tag}" --verify-tag --generate-notes --draft
fi

is_draft="$(gh release view "${tag}" --json isDraft --jq '.isDraft')"
if [[ "${is_draft}" != "true" ]]; then
  echo "release-assets: FAIL (${tag} is already published; immutable releases prevent adding assets/notes)" >&2
  exit 1
fi

target_commitish="$(gh release view "${tag}" --json targetCommitish --jq '.targetCommitish // ""')"
tag_ref="refs/tags/${tag}"
source_ref=""
allow_untagged_draft=false

if git show-ref --verify --quiet "${tag_ref}"; then
  source_ref="${tag}"
else
  if [[ -z "${target_commitish}" ]]; then
    echo "release-assets: FAIL (${tag} draft release has no tag ref and no targetCommitish)" >&2
    exit 1
  fi
  source_ref="${target_commitish}"
  allow_untagged_draft=true
fi

if ! git rev-parse --verify --quiet "${source_ref}^{commit}" >/dev/null; then
  echo "release-assets: FAIL (${tag} source ${source_ref} is not available after fetching ${main_branch}/${premain_branch}/tags)" >&2
  exit 1
fi

source_commit="$(git rev-parse "${source_ref}^{commit}")"

# Start the asset build from a clean tree for the resolved immutable release source.
git reset --hard HEAD
git clean -ffdx
git switch --detach "${source_commit}"

if [[ "${allow_untagged_draft}" == "true" ]]; then
  ALLOW_UNTAGGED_DRAFT_RELEASE=true \
    DRAFT_RELEASE_IS_DRAFT="${is_draft}" \
    DRAFT_RELEASE_TARGET="${target_commitish}" \
    scripts/verify-release-branch.sh "${tag}"
else
  scripts/verify-release-branch.sh "${tag}"
fi

echo "release-assets: source ${source_commit} for ${tag}"
{
  echo "### Release asset source"
  echo ""
  echo "- Tag: \`${tag}\`"
  echo "- Source commit: \`${source_commit}\`"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

export SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)"
make rubric
make build
scripts/generate-checksums.sh
scripts/render-release-notes.sh "${tag}"

mapfile -t existing_assets < <(gh release view "${tag}" --json assets --jq '.assets[].name' 2>/dev/null || true)

assets=(
  'dist/theory-cloud-apptheory*.tgz'
  'dist/apptheory*.whl'
  'dist/apptheory*.tar.gz'
  'dist/SHA256SUMS.txt'
)

for asset_glob in "${assets[@]}"; do
  shopt -s nullglob
  matches=( ${asset_glob} )
  shopt -u nullglob
  if (( ${#matches[@]} == 0 )); then
    echo "release-assets: FAIL (missing asset matching ${asset_glob})" >&2
    exit 1
  fi

  for asset_path in "${matches[@]}"; do
    asset_name="$(basename "${asset_path}")"
    if printf '%s\n' "${existing_assets[@]}" | grep -Fxq "${asset_name}"; then
      echo "release-assets: skip existing ${asset_name}"
      continue
    fi
    gh release upload "${tag}" "${asset_path}"
  done
done

prerelease_flag=()
if [[ "${tag}" =~ -rc(\.|$) ]]; then
  prerelease_flag=(--prerelease)
fi

gh release edit "${tag}" --target "${source_commit}" --draft=false "${prerelease_flag[@]}" --notes-file dist/RELEASE_NOTES.md

git fetch "${remote}" tag "${tag}" --force
scripts/verify-release-branch.sh "${tag}"

echo "release-assets: PASS (${tag} source=${source_commit})"
