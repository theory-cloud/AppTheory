#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail() {
  echo "ci-rubric: FAIL ($1)" >&2
  exit 1
}

require_contains() {
  local path="$1"
  local needle="$2"
  local description="$3"

  grep -Fq "${needle}" "${path}" || fail "${description}; missing ${needle} in ${path}"
}

require_not_contains() {
  local path="$1"
  local needle="$2"
  local description="$3"

  if grep -Fq "${needle}" "${path}"; then
    fail "${description}; unexpected ${needle} in ${path}"
  fi
}

ci=".github/workflows/ci.yml"

require_contains "${ci}" "  rubric:" "CI must define the full rubric job"
require_contains "${ci}" "run: make rubric" "CI rubric job must run make rubric"
require_contains \
  "${ci}" \
  "if: github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging')" \
  "full rubric must run only for PRs targeting staging plus manual dispatch"

for release_path in \
  ".github/workflows/prerelease.yml" \
  ".github/workflows/release.yml" \
  "scripts/publish-release-assets.sh" \
  "scripts/render-release-notes.sh"; do
  require_not_contains "${release_path}" "make rubric" "full rubric must not run in release build/publish paths"
done

require_contains ".github/workflows/prerelease.yml" "scripts/verify-release-publish-postcondition.sh prerelease" \
  "prerelease publisher must fail closed on release-please no-op after generated RC release PR merges"
require_contains ".github/workflows/release.yml" "scripts/verify-release-publish-postcondition.sh stable" \
  "stable publisher must fail closed on release-please no-op after generated stable release PR merges"
require_contains ".github/workflows/prerelease-pr.yml" "scripts/verify-release-pr-postcondition.sh prerelease" \
  "premain release PR generation must fail closed on release-please no-op"
require_contains ".github/workflows/release-pr.yml" "scripts/verify-release-pr-postcondition.sh stable" \
  "main release PR generation must fail closed on release-please no-op"

echo "ci-rubric: PASS"
