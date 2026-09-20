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
# every visible npm audit finding is the reviewed, self-expiring stream-json
# exception (advisory, CJS/ESM deadlock, 2026-09-20 operator ruling, and the
# automatic registry-backed expiry condition are documented in
# scripts/check-visible-aws-cdk-finding.mjs).
set +e
node scripts/check-visible-aws-cdk-finding.mjs npm "${tmp_report}" cdk/package-lock.json >"${tmp_marker}"
filter_status=$?
set -e
cat "${tmp_marker}"

if [[ "${filter_status}" -ne 0 ]]; then
  exit "${filter_status}"
fi

# npm audit exits 1 whenever it reports findings. That is acceptable only when
# the exception checker above both passed and positively identified the reviewed
# stream-json finding as the cause; any other scanner exit still fails closed.
case "${audit_status}" in
  0) ;;
  1)
    if ! grep -Fq 'exception-applied: ' "${tmp_marker}"; then
      echo "cdk-audit: FAIL (npm audit exited 1 without reporting the reviewed stream-json exception)" >&2
      exit 1
    fi
    ;;
  *)
    echo "cdk-audit: FAIL (npm audit exited ${audit_status})" >&2
    exit 1
    ;;
esac

echo "cdk-audit: PASS"
