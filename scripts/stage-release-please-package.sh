#!/usr/bin/env bash
# Purpose: install the pinned release-please package in a credential-free npm process.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ $# -ne 1 || -z "${1:-}" ]]; then
  echo "release-please-package: FAIL (exactly one package-root argument is required)" >&2
  exit 1
fi

for credential_name in RELEASE_PLEASE_TOKEN GH_TOKEN GITHUB_TOKEN; do
  if [[ -n "${!credential_name:-}" ]]; then
    echo "release-please-package: FAIL (GitHub credentials are forbidden at the npm boundary)" >&2
    exit 1
  fi
done

if ! command -v npm >/dev/null 2>&1; then
  echo "release-please-package: FAIL (npm not found)" >&2
  exit 1
fi

package_root="$1"
mkdir -p -- "${package_root}"

npm_config_loglevel=warn npm install \
  --ignore-scripts \
  --no-audit \
  --no-fund \
  --no-package-lock \
  --no-save \
  --prefix "${package_root}" \
  release-please@17.1.3
