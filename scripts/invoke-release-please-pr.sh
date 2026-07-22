#!/usr/bin/env bash
# Purpose: stage release-please without credentials, then invoke it with an environment-only token.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ $# -ne 0 ]]; then
  echo "release-please-pr: FAIL (environment-only transport does not accept arguments)" >&2
  exit 1
fi

for required_name in \
  RELEASE_PLEASE_TOKEN \
  RELEASE_PLEASE_REPO_URL \
  RELEASE_PLEASE_TARGET_BRANCH \
  RELEASE_PLEASE_CONFIG_FILE \
  RELEASE_PLEASE_MANIFEST_FILE; do
  if [[ -z "${!required_name:-}" ]]; then
    echo "release-please-pr: FAIL (missing ${required_name})" >&2
    exit 1
  fi
done

package_root="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/apptheory-release-please.XXXXXX")"
cleanup() {
  rm -rf -- "${package_root}"
}
trap cleanup EXIT

# npm is only a package-staging boundary. It must never receive any GitHub
# credential, including ambient credentials that are not used by release-please.
if ! (
  unset RELEASE_PLEASE_TOKEN GH_TOKEN GITHUB_TOKEN
  bash scripts/stage-release-please-package.sh "${package_root}"
); then
  echo "release-please-pr: FAIL (could not stage pinned release-please package)" >&2
  exit 1
fi

release_please_module="${package_root}/node_modules/release-please/build/src/bin/release-please.js"
if [[ ! -f "${release_please_module}" ]]; then
  echo "release-please-pr: FAIL (could not resolve pinned release-please module)" >&2
  exit 1
fi

# The in-process launcher needs only the dedicated release-please credential.
# Keep ambient gh credentials out of this boundary as well.
set +e
(
  unset GH_TOKEN GITHUB_TOKEN
  RELEASE_PLEASE_PACKAGE_ROOT="${package_root}/node_modules/release-please" \
  RELEASE_PLEASE_CLI_MODULE="${release_please_module}" \
    node scripts/invoke-release-please-pr.mjs
)
status=$?
set -e
exit "${status}"
