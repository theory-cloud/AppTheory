#!/usr/bin/env bash
# Purpose: verify CI still runs the required rubric gate on the intended branches.
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

  grep -Fq -- "${needle}" "${path}" || fail "${description}; missing ${needle} in ${path}"
}

require_not_contains() {
  local path="$1"
  local needle="$2"
  local description="$3"

  if grep -Fq -- "${needle}" "${path}"; then
    fail "${description}; unexpected ${needle} in ${path}"
  fi
}

require_job_without_if() {
  local path="$1"
  local job="$2"
  local description="$3"

  if awk -v job="  ${job}:" '
    $0 == job { in_job = 1; next }
    in_job && /^  [A-Za-z0-9_-]+:/ { in_job = 0 }
    in_job && /^    if:/ { found = 1 }
    END { exit found ? 0 : 1 }
  ' "${path}"; then
    fail "${description}; job-level if is not allowed"
  fi
}

ci=".github/workflows/ci.yml"

require_contains "${ci}" "  release-security-gates:" \
  "CI must define non-skipped release/security gates independent of the full rubric"
require_contains "${ci}" "name: Release/security gates" \
  "CI must keep the release/security gate check name stable for branch protection visibility"
require_job_without_if "${ci}" "release-security-gates" \
  "release/security gates must not be skipped by branch or dispatch conditions"
require_contains "${ci}" "bash scripts/verify-branch-release-supply-chain.sh" \
  "release/security gates must verify release supply-chain workflow wiring"
require_contains "${ci}" "bash scripts/verify-release-train-promotion.sh --self-test" \
  "release/security gates must exercise release train provenance self-tests"
require_contains "${ci}" "bash scripts/verify-ci-rubric-enforced.sh" \
  "release/security gates must verify CI rubric enforcement invariants"
require_contains "${ci}" "bash scripts/verify-release-workflows.sh" \
  "release/security gates must verify release workflow invariants"
require_contains "${ci}" "bash scripts/verify-release-cycle.sh" \
  "release/security gates must verify deterministic release-cycle fixtures"
require_contains "${ci}" "bash scripts/verify-runtime-floor-claims.sh" \
  "release/security gates must fail closed on unsupported Python/Node floor claims"
require_contains "${ci}" "  rubric:" "CI must define the full rubric job"
require_contains "${ci}" "run: make rubric" "CI rubric job must run make rubric"
require_contains "${ci}" "run_full_rubric:" \
  "manual CI dispatch must expose an explicit full-rubric toggle"
require_contains "${ci}" "default: true" \
  "manual CI dispatch must continue to run the full rubric by default"
require_contains \
  "${ci}" \
  "if: (github.event_name == 'workflow_dispatch' && (inputs.run_full_rubric == true || inputs.run_full_rubric == 'true')) || (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging')" \
  "full rubric must run only for PRs targeting staging plus opted-in manual dispatch"
require_contains "${ci}" "  builds:" "CI must define the standalone deterministic-build job"
require_contains "${ci}" "name: Verify deterministic builds" \
  "CI must keep the deterministic-build job name stable for branch protection visibility"
require_contains \
  "${ci}" \
  "if: github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging'" \
  "deterministic builds must run only for PRs targeting staging"
require_contains "scripts/sync-release-pr-generated.sh" "--raw-field run_full_rubric=false" \
  "automated generated release PR CI dispatch must opt out of the full rubric"
require_not_contains "scripts/sync-release-pr-generated.sh" "Rubric (full gate set)" \
  "generated release PR required checks must exclude the full rubric"
require_not_contains "scripts/sync-release-pr-generated.sh" "Verify deterministic builds" \
  "generated release PR required checks must exclude skipped deterministic builds"

for release_path in \
  ".github/workflows/prerelease.yml" \
  ".github/workflows/release.yml" \
  "scripts/publish-release-assets.sh" \
  "scripts/render-release-notes.sh"; do
  require_not_contains "${release_path}" "make rubric" "full rubric must not run in release build/publish paths"
  require_not_contains "${release_path}" "Verify deterministic builds" \
    "deterministic builds must not be a release build/publish path"
  require_not_contains "${release_path}" "scripts/verify-builds.sh" \
    "release build/publish paths must not run deterministic builds"
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
