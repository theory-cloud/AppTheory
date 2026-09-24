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

# Fail closed unless the AWS CDK bundled dependency graph is exactly patched and
# the audit surface carries zero findings. This repository grants no
# dependency-audit exceptions; the checker below is the single place that could
# have granted one, and its last exception retired on 2026-09-22 with the
# jsii-rosetta 6.0.16 bump (see scripts/check-visible-aws-cdk-finding.mjs).
set +e
node scripts/check-visible-aws-cdk-finding.mjs npm "${tmp_report}" cdk/package-lock.json >"${tmp_marker}"
filter_status=$?
set -e
cat "${tmp_marker}"

if [[ "${filter_status}" -ne 0 ]]; then
  exit "${filter_status}"
fi

# npm audit exits 1 whenever it reports findings, and this project tolerates
# none, so any non-zero exit fails closed.
case "${audit_status}" in
  0) ;;
  *)
    echo "cdk-audit: FAIL (npm audit exited ${audit_status})" >&2
    exit 1
    ;;
esac

echo "cdk-audit: PASS"
