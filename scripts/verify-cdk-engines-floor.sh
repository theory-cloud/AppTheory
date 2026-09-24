#!/usr/bin/env bash
# Purpose: fail when a CDK lockfile dependency declares engines.node outside the CDK Node floor.
#
# The checker owns the policy and the floor it derives from cdk/package.json.
# This wrapper deliberately accepts no arguments: the shipped gate always scans
# the whole CDK lockfile set, so no caller can narrow it or waive a package.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "cdk-engines-floor: BLOCKED (node not found)" >&2
  exit 2
fi
if [[ ! -f "cdk/package.json" ]]; then
  echo "cdk-engines-floor: FAIL (missing cdk/package.json)" >&2
  exit 1
fi
if [[ ! -f "cdk/package-lock.json" ]]; then
  echo "cdk-engines-floor: FAIL (missing cdk/package-lock.json)" >&2
  exit 1
fi
if [[ "$#" -ne 0 ]]; then
  echo "cdk-engines-floor: FAIL (this gate takes no arguments)" >&2
  exit 1
fi

node scripts/check-cdk-engines-floor.mjs --self-test
