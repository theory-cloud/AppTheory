#!/usr/bin/env bash
# Purpose: audit CDK sources for construct and dependency policy violations.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v npm >/dev/null 2>&1; then
  echo "cdk-audit: BLOCKED (npm not found)" >&2
  exit 1
fi
if [[ ! -d "cdk" ]]; then
  echo "cdk-audit: FAIL (missing cdk/)" >&2
  exit 1
fi
if [[ ! -f "cdk/package-lock.json" ]]; then
  echo "cdk-audit: FAIL (missing cdk/package-lock.json)" >&2
  exit 1
fi

tmp_report="$(mktemp)"
cleanup() {
  rm -f "${tmp_report}"
}
trap cleanup EXIT

set +e
npm --prefix cdk audit --audit-level=moderate --json >"${tmp_report}"
audit_status=$?
set -e

if [[ "${audit_status}" -eq 0 ]]; then
  echo "cdk-audit: PASS"
  exit 0
fi

# Fail closed with one intentionally narrow, visible exception for an upstream
# AWS CDK bundled dependency. The shared checker pins the advisory, dependency
# graph, lockfile path, expiry, and scanner-specific report shape.
node scripts/check-visible-aws-cdk-finding.mjs npm "${tmp_report}" cdk/package-lock.json

echo "cdk-audit: PASS"
