#!/usr/bin/env bash
# Purpose: run the offline fixture tables for the visible-finding checkers.
#
# Both checkers decide whether a dependency-audit finding is visible to CI.
# Their fixture tables are the regression guard for those fail-closed decisions
# (lockfile graph drift, malformed scanner reports, planted node paths), so run
# them wherever the checkers themselves run.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "test-check-visible-findings: BLOCKED (node not found)" >&2
  exit 2
fi

node scripts/check-visible-ts-brace-finding.mjs --self-test
node scripts/check-visible-aws-cdk-finding.mjs --self-test

echo "test-check-visible-findings: PASS"
