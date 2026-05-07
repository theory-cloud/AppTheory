#!/usr/bin/env bash
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

npm --prefix cdk audit --audit-level=moderate >/dev/null

echo "cdk-audit: PASS"
