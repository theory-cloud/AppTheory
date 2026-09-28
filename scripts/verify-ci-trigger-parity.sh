#!/usr/bin/env bash
# Purpose: fail closed when the CI job/trigger wiring lets a job run on a path
# that can promote code (a push to a protected release branch, or a
# staging->premain / premain->main promotion pull request) without an equivalent
# job running on pull requests to staging -- the TableTheory #623 class, where a
# pull request merges green and the promotion then fails on a gate it never ran.
#
# Requirements enforced (R-F1 as amended by the operator ruling of 2026-09-28,
# "the rubric is only needed in staging; premain and main only ever come from
# staging and do not need to repeat the full rubric"):
#   A. the rubric job runs only for pull requests targeting staging, plus the
#      opt-in manual dispatch, and nowhere else;
#   B. the deterministic-build job has the same staging-pull-request-only shape;
#   C. every other job that can run on a push to staging/premain/main can also
#      run on a pull request to staging;
#   D. every job that runs only on a promotion pull request has a pull-request-
#      to-staging equivalent, or is an exemption with a recorded counterpart and
#      reason;
#   E. both promotion lanes are covered (staging->premain and premain->main).
#
# The check is delegated to cmd/ci-guard, which parses the workflow as YAML and
# classifies every job by its effective triggers (workflow `on:` x job `if:`).
# A job condition the classifier does not model -- a negated or `!=` predicate
# over an unknown ref, a folded/continuation scalar, a YAML alias or merge key,
# a `pull_request` branch filter -- fails closed rather than passing: matching
# the raw text let `|| (github.event_name != 'pull_request')`,
# `|| (github.ref == 'refs/heads/staging')` and a continuation-line clause
# broaden the rubric while the guard passed.
#
# Exit codes: 0 PASS, 1 FAIL, 2 BLOCKED.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v go >/dev/null 2>&1; then
  echo "ci-trigger-parity: BLOCKED (go toolchain not found; cmd/ci-guard parses the workflow)" >&2
  exit 2
fi

go run ./cmd/ci-guard workflow-triggers --root "$(pwd)" --workflow ".github/workflows/ci.yml"
