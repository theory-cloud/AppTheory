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

release_asset_globs=(
  'dist/theory-cloud-apptheory*.tgz'
  'dist/apptheory*.whl'
  'dist/apptheory*.tar.gz'
  'dist/SHA256SUMS.txt'
)

sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${path}" | awk '{print $1}'
  else
    shasum -a 256 "${path}" | awk '{print $1}'
  fi
}

release_is_draft() {
  gh release view "${tag}" --json isDraft --jq '.isDraft'
}

release_target_commitish() {
  gh release view "${tag}" --json targetCommitish --jq '.targetCommitish // ""'
}

resolve_commitish() {
  local ref="$1"
  git rev-parse --verify --quiet "${ref}^{commit}" 2>/dev/null
}

collect_release_assets() {
  local -n out="$1"
  out=()

  for asset_glob in "${release_asset_globs[@]}"; do
    shopt -s nullglob
    matches=( ${asset_glob} )
    shopt -u nullglob
    if (( ${#matches[@]} == 0 )); then
      echo "release-assets: FAIL (missing asset matching ${asset_glob})" >&2
      exit 1
    fi

    out+=( "${matches[@]}" )
  done
}

assert_release_target_matches_source() {
  local current_target="$1"
  local resolved_target=""

  if [[ -z "${current_target}" ]]; then
    echo "release-assets: FAIL (${tag} published release has no targetCommitish; refusing to trust immutable assets)" >&2
    exit 1
  fi

  resolved_target="$(resolve_commitish "${current_target}" || true)"
  if [[ -z "${resolved_target}" ]]; then
    echo "release-assets: FAIL (${tag} release target ${current_target} is not available after fetching refs)" >&2
    exit 1
  fi

  if [[ "${resolved_target}" != "${source_commit}" ]]; then
    echo "release-assets: FAIL (${tag} release target ${resolved_target} does not match source ${source_commit})" >&2
    exit 1
  fi
}

verify_published_release_assets() {
  local current_target=""
  local download_dir=""
  local published_names=""

  current_target="$(release_target_commitish)"
  assert_release_target_matches_source "${current_target}"

  published_names="$(gh release view "${tag}" --json assets --jq '.assets[].name')"

  download_dir="$(mktemp -d)"
  cleanup_download_dir() {
    rm -rf "${download_dir}"
  }
  trap cleanup_download_dir RETURN

  for asset_path in "${asset_paths[@]}"; do
    asset_name="$(basename "${asset_path}")"
    if ! grep -Fxq "${asset_name}" <<<"${published_names}"; then
      echo "release-assets: FAIL (${tag} published release is missing immutable asset ${asset_name})" >&2
      exit 1
    fi

    rm -f "${download_dir}/${asset_name}"
    gh release download "${tag}" --pattern "${asset_name}" --dir "${download_dir}" >/dev/null
    if [[ ! -f "${download_dir}/${asset_name}" ]]; then
      echo "release-assets: FAIL (${tag} published asset ${asset_name} did not download)" >&2
      exit 1
    fi

    expected_sha="$(sha256_file "${asset_path}")"
    actual_sha="$(sha256_file "${download_dir}/${asset_name}")"
    if [[ "${actual_sha}" != "${expected_sha}" ]]; then
      echo "release-assets: FAIL (${tag} published asset ${asset_name} sha256 ${actual_sha} does not match source build ${expected_sha})" >&2
      exit 1
    fi
  done

  trap - RETURN
  cleanup_download_dir
  echo "release-assets: SKIP (${tag} already published with matching immutable assets)"
}

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

is_draft="$(release_is_draft)"
target_commitish="$(release_target_commitish)"
tag_ref="refs/tags/${tag}"
source_ref=""
allow_untagged_draft=false

if git show-ref --verify --quiet "${tag_ref}"; then
  source_ref="${tag}"
else
  if [[ "${is_draft}" != "true" ]]; then
    echo "release-assets: FAIL (${tag} published release has no local tag ref; refusing to trust immutable assets)" >&2
    exit 1
  fi
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
scripts/verify-version-alignment.sh
make build
scripts/generate-checksums.sh
scripts/render-release-notes.sh "${tag}"

asset_paths=()
collect_release_assets asset_paths

is_draft="$(release_is_draft)"
if [[ "${is_draft}" != "true" ]]; then
  verify_published_release_assets
  git fetch "${remote}" tag "${tag}" --force
  scripts/verify-release-branch.sh "${tag}"
  echo "release-assets: PASS (${tag} source=${source_commit})"
  exit 0
fi

for asset_path in "${asset_paths[@]}"; do
  # Draft recovery must never trust pre-existing asset bytes by filename.
  # Always replace the draft asset with the artifact built and checksummed
  # from source_commit in this run before publishing the immutable release.
  if ! gh release upload "${tag}" "${asset_path}" --clobber; then
    is_draft="$(release_is_draft)"
    if [[ "${is_draft}" != "true" ]]; then
      verify_published_release_assets
      git fetch "${remote}" tag "${tag}" --force
      scripts/verify-release-branch.sh "${tag}"
      echo "release-assets: PASS (${tag} source=${source_commit})"
      exit 0
    fi

    echo "release-assets: FAIL (${tag} failed to upload draft asset $(basename "${asset_path}"))" >&2
    exit 1
  fi
done

prerelease_flag=()
if [[ "${tag}" =~ -rc(\.|$) ]]; then
  prerelease_flag=(--prerelease)
fi

is_draft="$(release_is_draft)"
if [[ "${is_draft}" != "true" ]]; then
  verify_published_release_assets
  git fetch "${remote}" tag "${tag}" --force
  scripts/verify-release-branch.sh "${tag}"
  echo "release-assets: PASS (${tag} source=${source_commit})"
  exit 0
fi

gh release edit "${tag}" --target "${source_commit}" --draft=false "${prerelease_flag[@]}" --notes-file dist/RELEASE_NOTES.md

git fetch "${remote}" tag "${tag}" --force
scripts/verify-release-branch.sh "${tag}"

echo "release-assets: PASS (${tag} source=${source_commit})"
