#!/usr/bin/env bash
# Purpose: audit CDK sources for construct and dependency policy violations.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v npm >/dev/null 2>&1; then
  echo "cdk-audit: BLOCKED (npm not found)" >&2
  exit 2
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
tmp_marker="$(mktemp)"
cleanup() {
  rm -f "${tmp_report}" "${tmp_marker}"
}
trap cleanup EXIT

set +e
npm --prefix cdk audit --audit-level=moderate --json >"${tmp_report}"
audit_status=$?
set -e

# Run the checker's offline battery first: it proves the negative cases this gate
# relies on (a different advisory id, version, node path, or lockfile, an expired
# recheck_by, or a met removal condition) still fail closed.
node scripts/check-visible-aws-cdk-finding.mjs --self-test

# Fail closed unless the AWS CDK bundled dependency graph is exactly the reviewed
# graph and every visible npm audit finding is one of the two reviewed,
# self-expiring exceptions (an AWS-published bundled dependency, and an
# AWS-published build-toolchain transitive chain). The operator rulings, exact
# scope, and automatic registry-backed removal conditions are documented in
# scripts/check-visible-aws-cdk-finding.mjs.
set +e
node scripts/check-visible-aws-cdk-finding.mjs npm "${tmp_report}" cdk/package-lock.json >"${tmp_marker}"
filter_status=$?
set -e
cat "${tmp_marker}"

if [[ "${filter_status}" -ne 0 ]]; then
  exit "${filter_status}"
fi

# npm audit exits 1 whenever it reports findings. That is acceptable only when
# the exception checker above both passed and positively identified a reviewed
# exception as the cause; any other scanner exit still fails closed.
case "${audit_status}" in
  0) ;;
  1)
    if ! grep -Fq 'exception-applied: ' "${tmp_marker}"; then
      echo "cdk-audit: FAIL (npm audit exited 1 without reporting a reviewed exception)" >&2
      exit 1
    fi
    ;;
  *)
    echo "cdk-audit: FAIL (npm audit exited ${audit_status})" >&2
    exit 1
    ;;
esac

echo "cdk-audit: PASS"
