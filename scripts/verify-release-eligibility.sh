#!/usr/bin/env bash
# Purpose: verify that a promotion range contains at least one release-eligible
# Conventional Commit (feat:/fix:/perf:), because release-please ships nothing
# else.
#
# This single predicate is shared by the two CI surfaces that must agree:
#   - "Prerelease readiness (staging → premain)" on the staging -> premain PR,
#     over origin/premain..origin/staging (the promotion range itself).
#   - "Release eligibility (staging → premain)" on PRs to staging and on pushes
#     to staging, over origin/premain..HEAD (the range that would exist after the
#     change lands, so a PR cannot be green while its promotion fails).
#
# Exit codes: 0 PASS, 1 FAIL (range not release-eligible), 2 BLOCKED (invalid
# invocation or an unresolvable range).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

range=""
context=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --range)
      range="${2:-}"
      shift 2
      ;;
    --context)
      context="${2:-}"
      shift 2
      ;;
    --help|-h)
      cat <<'USAGE'
usage: scripts/verify-release-eligibility.sh --range <rev-range> --context <label>

Fails closed unless the given git revision range contains at least one
release-eligible Conventional Commit subject: feat|fix|perf with an optional
scope and optional breaking-change marker.
USAGE
      exit 0
      ;;
    *)
      echo "release-eligibility: FAIL (unknown argument: $1)" >&2
      exit 2
      ;;
  esac
done

if [[ -z "${range}" || -z "${context}" ]]; then
  echo "release-eligibility: FAIL (--range and --context are required)" >&2
  exit 2
fi

if ! command -v git >/dev/null 2>&1; then
  echo "release-eligibility: BLOCKED (git not found)" >&2
  exit 2
fi

echo "release-eligibility: checking commits in ${range} (${context})"

# A range that git cannot resolve is a broken invocation or missing history, not
# a release-eligibility verdict: block rather than pass.
if ! commit_subjects="$(git log --format=%s "${range}" 2>&1)"; then
  echo "release-eligibility: BLOCKED (cannot resolve ${range})" >&2
  printf '%s\n' "${commit_subjects}" >&2
  exit 2
fi

# Do not pipe directly into grep -q under pipefail: grep exits as soon as it
# finds a match, which can SIGPIPE git log and make a matching commit look like a
# failed eligibility check.
if grep -Eq '^(feat|fix|perf)(\([^)]+\))?(!)?: ' <<<"${commit_subjects}"; then
  echo "release-eligibility: PASS (${context})"
  exit 0
fi

echo "release-eligibility: FAIL (${context})"
echo "No user-facing conventional commits (feat:/fix:/perf:) found in ${range}."
echo "release-please will skip, so no new release will be cut."
echo
echo "Commit subjects:"
printf '%s\n' "${commit_subjects}" || true
exit 1
