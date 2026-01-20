#!/usr/bin/env bash
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

expected_version="$(tr -d ' \t\r\n' < VERSION)"
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

if [[ "${expected_version}" == *"-rc."* ]]; then
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

echo "release-branch: PASS (${expected_tag})"
