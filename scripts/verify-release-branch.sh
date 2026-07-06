#!/usr/bin/env bash
# Purpose: verify release branch names and source/target combinations are allowed.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

tag="${1:-${GITHUB_REF_NAME:-}}"
if [[ -z "${tag}" ]]; then
  echo "release-branch: FAIL (missing tag name)"
  exit 1
fi

if [[ ! -f "VERSION" ]]; then
  echo "release-branch: FAIL (missing VERSION)"
  exit 1
fi

expected_version="$(./scripts/read-version.sh)"
expected_tag="v${expected_version}"

if [[ "${tag}" != "${expected_tag}" ]]; then
  echo "release-branch: FAIL (tag ${tag} != ${expected_tag})"
  exit 1
fi

remote="${GIT_REMOTE:-origin}"
main_branch="${MAIN_BRANCH:-main}"
premain_branch="${PREMAIN_BRANCH:-premain}"

main_ref="refs/remotes/${remote}/${main_branch}"
premain_ref="refs/remotes/${remote}/${premain_branch}"

if ! git show-ref --verify --quiet "${main_ref}"; then
  echo "release-branch: FAIL (missing ${main_ref}; run: git fetch ${remote} ${main_branch})"
  exit 1
fi

if ! git show-ref --verify --quiet "${premain_ref}"; then
  echo "release-branch: FAIL (missing ${premain_ref}; run: git fetch ${remote} ${premain_branch})"
  exit 1
fi

commit="$(git rev-parse HEAD)"
tag_ref="refs/tags/${tag}"

if git show-ref --verify --quiet "${tag_ref}"; then
  tag_commit="$(git rev-parse "${tag_ref}^{commit}")"
else
  if [[ "${ALLOW_UNTAGGED_DRAFT_RELEASE:-}" != "true" ]]; then
    echo "release-branch: FAIL (missing ${tag_ref}; run: git fetch ${remote} tag ${tag})"
    exit 1
  fi

  if [[ "${DRAFT_RELEASE_IS_DRAFT:-}" != "true" ]]; then
    echo "release-branch: FAIL (${tag} has no tag ref and is not an explicitly verified draft release)"
    exit 1
  fi

  if [[ -z "${DRAFT_RELEASE_TARGET:-}" ]]; then
    echo "release-branch: FAIL (${tag} has no tag ref and no draft release target)"
    exit 1
  fi

  tag_commit="$(git rev-parse "${DRAFT_RELEASE_TARGET}^{commit}")"
fi

if [[ "${commit}" != "${tag_commit}" ]]; then
  echo "release-branch: FAIL (HEAD ${commit} != ${tag} ${tag_commit}; build assets from the immutable release source)"
  exit 1
fi

# release-please uses `prerelease-type: rc` and may emit either:
# - `X.Y.Z-rc` (first RC on a new track)
# - `X.Y.Z-rc.N` (subsequent RCs)
if [[ "${expected_version}" =~ -rc(\.|$) ]]; then
  if ! git merge-base --is-ancestor "${commit}" "${premain_ref}"; then
    echo "release-branch: FAIL (${expected_tag} must be tagged from ${premain_branch})"
    exit 1
  fi
else
  if ! git merge-base --is-ancestor "${commit}" "${main_ref}"; then
    echo "release-branch: FAIL (${expected_tag} must be tagged from ${main_branch})"
    exit 1
  fi
fi

echo "release-branch: PASS (${expected_tag} source=${commit})"
