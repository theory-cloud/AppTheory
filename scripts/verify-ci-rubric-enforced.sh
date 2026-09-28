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

require_line() {
  local path="$1"
  local needle="$2"
  local description="$3"

  grep -Fxq -- "${needle}" "${path}" || fail "${description}; missing exact line ${needle} in ${path}"
}

require_line_order() {
  local path="$1"
  local first="$2"
  local second="$3"
  local description="$4"
  local first_line
  local second_line

  first_line="$(grep -Fxn -- "${first}" "${path}" | head -n1 | cut -d: -f1 || true)"
  second_line="$(grep -Fxn -- "${second}" "${path}" | head -n1 | cut -d: -f1 || true)"

  [[ -n "${first_line}" ]] || fail "${description}; missing exact line ${first} in ${path}"
  [[ -n "${second_line}" ]] || fail "${description}; missing exact line ${second} in ${path}"

  if (( first_line >= second_line )); then
    fail "${description}; ${first} must appear before ${second} in ${path}"
  fi
}

require_not_contains() {
  local path="$1"
  local needle="$2"
  local description="$3"

  if grep -Fq -- "${needle}" "${path}"; then
    fail "${description}; unexpected ${needle} in ${path}"
  fi
}

require_job_contains() {
  local path="$1"
  local job="$2"
  local needle="$3"
  local description="$4"

  awk -v job="  ${job}:" -v needle="${needle}" '
    $0 == job { in_job = 1; next }
    in_job && /^  [A-Za-z0-9_-]+:/ { in_job = 0 }
    in_job && index($0, needle) { found = 1 }
    END { exit found ? 0 : 1 }
  ' "${path}" || fail "${description}; missing ${needle} in ${job} job"
}

require_job_not_contains() {
  local path="$1"
  local job="$2"
  local needle="$3"
  local description="$4"

  if awk -v job="  ${job}:" -v needle="${needle}" '
    $0 == job { in_job = 1; next }
    in_job && /^  [A-Za-z0-9_-]+:/ { in_job = 0 }
    in_job && index($0, needle) { found = 1 }
    END { exit found ? 0 : 1 }
  ' "${path}"; then
    fail "${description}; unexpected ${needle} in ${job} job"
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
release_please_draft_guard="if: github.event_name != 'pull_request' || github.event.pull_request.draft == false || (github.event.pull_request.head.ref != 'release-please--branches--premain' && github.event.pull_request.head.ref != 'release-please--branches--main')"

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
require_line "${ci}" "  cdk-go-drift:" \
  "CI must define the dedicated cdk-go generated binding drift job"
require_contains "${ci}" "name: CDK Go binding drift" \
  "CI must keep the cdk-go drift check name stable for branch protection visibility"
require_job_contains "${ci}" "cdk-go-drift" "${release_please_draft_guard}" \
  "cdk-go drift must use the standard draft release-please guard and otherwise run"
require_job_contains "${ci}" "cdk-go-drift" "run: scripts/verify-cdk-go-drift.sh" \
  "cdk-go drift job must execute the generated binding drift verifier"
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
# Operator ruling (2026-09-28): the rubric is staging-only. The staging ruleset
# requires it with strict_required_status_checks_policy: true, so the merged
# staging SHA is the tested SHA; premain and main only ever receive staging
# content and must not repeat the full rubric. Neither the rubric nor the
# deterministic-build job may be broadened to a push or to a promotion PR — the
# promotion lanes run no rubric, so requiring it there would deadlock them.
for staging_only_job in rubric builds; do
  require_job_not_contains "${ci}" "${staging_only_job}" "base.ref == 'premain'" \
    "${staging_only_job} must not run on the staging->premain promotion PR (rubric is staging-PR-only)"
  require_job_not_contains "${ci}" "${staging_only_job}" "base.ref == 'main'" \
    "${staging_only_job} must not run on a premain->main promotion PR (rubric is staging-PR-only)"
  require_job_not_contains "${ci}" "${staging_only_job}" "github.event_name == 'push'" \
    "${staging_only_job} must not run on a push; the staging ruleset pins the staging-PR run strict instead"
done
require_job_contains "${ci}" "rubric" "uses: actions/upload-artifact@" \
  "full rubric must publish the GovTheory evidence report as a retrievable artifact"
require_job_contains "${ci}" "rubric" "path: gov-infra/evidence/" \
  "published GovTheory evidence artifact must cover the verifier evidence directory"
require_job_contains "${ci}" "rubric" "if: always()" \
  "GovTheory evidence artifact must upload even when the rubric fails"
require_contains "scripts/sync-release-pr-generated.sh" "--raw-field run_full_rubric=false" \
  "automated generated release PR CI dispatch must opt out of the full rubric"
require_not_contains "scripts/sync-release-pr-generated.sh" "Rubric (full gate set)" \
  "generated release PR required checks must exclude the full rubric"
require_not_contains "scripts/sync-release-pr-generated.sh" "Verify deterministic builds" \
  "generated release PR required checks must exclude skipped deterministic builds"

# R-F1 staging-side readiness equivalence: the promotion lane's readiness gate
# and the staging lane's eligibility gate must be the same predicate, so a PR
# cannot be green while its promotion fails on release eligibility.
require_contains "${ci}" "  staging-release-eligibility:" \
  "CI must define the staging-lane release-eligibility job"
require_contains "${ci}" "name: Release eligibility (staging → premain)" \
  "staging release eligibility must keep a stable branch-protection check name"
require_job_contains "${ci}" "staging-release-eligibility" \
  "if: (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging') || (github.event_name == 'push' && github.ref == 'refs/heads/staging')" \
  "staging release eligibility must run on PRs to staging and on pushes to staging"
require_job_contains "${ci}" "staging-release-eligibility" "bash scripts/verify-release-eligibility.sh" \
  "staging release eligibility must use the shared release-eligibility predicate"
require_job_contains "${ci}" "staging-release-eligibility" '--range "origin/premain..HEAD"' \
  "staging release eligibility must check the post-merge promotion range"
require_job_contains "${ci}" "prerelease-readiness" "bash scripts/verify-release-eligibility.sh" \
  "prerelease readiness must use the shared release-eligibility predicate"
require_job_contains "${ci}" "prerelease-readiness" '--range "origin/premain..origin/staging"' \
  "prerelease readiness must check the exact promotion range"
require_contains "scripts/verify-release-eligibility.sh" "^(feat|fix|perf)(\\([^)]+\\))?(!)?: " \
  "the shared release-eligibility predicate must require a release-eligible conventional commit"

# Toolchain-provisioning parity: the promotion-path rubric job and the PR-to-
# staging rubric job are the same job, so its pinned toolchain is provisioned
# identically on every lane it now runs on.
for provisioned in \
  "actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e" \
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020" \
  "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97" \
  "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.9.0"; do
  require_job_contains "${ci}" "rubric" "${provisioned}" \
    "full rubric must provision its pinned toolchain on every lane it runs on"
done
# The release-eligibility predicate is git-only. Assert that so the staging PR
# lane and the promotion lane cannot diverge by provisioning.
for unprovisioned in \
  "actions/setup-go@" \
  "actions/setup-node@" \
  "actions/setup-python@"; do
  for eligibility_job in staging-release-eligibility prerelease-readiness; do
    if awk -v job="  ${eligibility_job}:" -v needle="${unprovisioned}" '
      $0 == job { in_job = 1; next }
      in_job && /^  [A-Za-z0-9_-]+:/ { in_job = 0 }
      in_job && index($0, needle) { found = 1 }
      END { exit found ? 0 : 1 }
    ' "${ci}"; then
      fail "release eligibility must not depend on a toolchain the other lane does not provision; ${eligibility_job} uses ${unprovisioned}"
    fi
  done
done

# Job-trigger parity (R-F1): enumerate every non-rubric job whose condition can
# only fire on the promotion lane, and every non-rubric job that can only fire on
# a push to staging/premain/main. A new promotion-only or push-only job fails
# this guard until it is given a staging-PR equivalent with the same toolchain
# and recorded below. The rubric itself is staging-PR-only by operator ruling
# (2026-09-28) and is enumerated as staging-only above, not here.
promotion_only_jobs="$(
  awk \
    -v base_staging="base.ref == 'staging'" \
    -v premain="base.ref == 'premain'" \
    -v head_staging="head.ref == 'staging'" '
    /^  [A-Za-z0-9_-]+:/ { job = $1; sub(/:$/, "", job); in_job = 1; next }
    in_job && /^    if:/ {
      line = $0
      if ((index(line, premain) || index(line, head_staging)) && index(line, base_staging) == 0) print job
    }
  ' "${ci}" | sort -u | tr '\n' ' '
)"
push_only_jobs="$(
  awk \
    -v base_staging="base.ref == 'staging'" \
    -v push_staging="github.ref == 'refs/heads/staging'" \
    -v push_premain="github.ref == 'refs/heads/premain'" \
    -v push_main="github.ref == 'refs/heads/main'" '
    /^  [A-Za-z0-9_-]+:/ { job = $1; sub(/:$/, "", job); in_job = 1; next }
    in_job && /^    if:/ {
      line = $0
      if ((index(line, push_staging) || index(line, push_premain) || index(line, push_main)) && index(line, base_staging) == 0) print job
    }
  ' "${ci}" | sort -u | tr '\n' ' '
)"

case " ${promotion_only_jobs} " in
  *" prerelease-readiness "*) : ;;
  *) fail "promotion-lane job enumeration did not find prerelease-readiness; the parity check is vacuous" ;;
esac

for promotion_job in ${promotion_only_jobs}; do
  case " prerelease-readiness " in
    *" ${promotion_job} "*) : ;;
    *)
      fail "promotion-lane job '${promotion_job}' has no staging-PR equivalent; add one (or record the justified exception here and in the PR body)"
      ;;
  esac
done

if [[ -n "${push_only_jobs// /}" ]]; then
  fail "push-to-staging-premain-main-only job(s) have no PR-to-staging equivalent:${push_only_jobs}"
fi

# The staging release-eligibility gate runs on PRs to staging and on pushes to
# staging through one predicate; assert the push leg so the PR-side equivalent
# cannot be silently removed.
require_job_contains "${ci}" "staging-release-eligibility" \
  "github.event_name == 'push' && github.ref == 'refs/heads/staging'" \
  "staging-release-eligibility must remain enumerated as a push-to-staging job covered by the parity check"

require_line "scripts/verify-rubric.sh" "bash ./scripts/verify-cdk-go-drift.sh" \
  "full rubric must verify cdk-go generated binding drift"
require_line_order \
  "scripts/verify-rubric.sh" \
  "bash ./scripts/verify-cdk-go-drift.sh" \
  "bash ./gov-infra/verifiers/gov-verify-rubric.sh" \
  "full rubric must fail stale generated bindings before the GovTheory verifier"

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
