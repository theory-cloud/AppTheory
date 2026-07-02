#!/usr/bin/env bash
# Verify checked-in jsii Go bindings match the CDK TypeScript source.
# Usage: ./scripts/verify-cdk-go-drift.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "cdk-go-drift: FAIL (must run inside a git work tree)" >&2
  exit 1
fi
if [[ ! -d "cdk-go" ]]; then
  echo "cdk-go-drift: FAIL (missing cdk-go/)" >&2
  exit 1
fi

bash ./scripts/update-cdk-generated.sh

if ! git diff --quiet -- cdk-go/; then
  echo "cdk-go-drift: FAIL (cdk-go bindings are stale; run ./scripts/update-cdk-generated.sh and commit the diff)" >&2
  git diff --stat -- cdk-go/ >&2 || true
  exit 1
fi

echo "cdk-go-drift: PASS"
