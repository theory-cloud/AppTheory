#!/usr/bin/env bash
# Purpose: verify the generated CDK Go binding package compiles and tests.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v go >/dev/null 2>&1; then
  echo "cdk-go: BLOCKED (go not found)" >&2
  exit 1
fi
if [[ ! -d "cdk-go/apptheorycdk" ]]; then
  echo "cdk-go: FAIL (missing cdk-go/apptheorycdk)" >&2
  exit 1
fi
if [[ ! -f "cdk-go/go.mod" ]]; then
  echo "cdk-go: FAIL (missing nested cdk-go/go.mod)" >&2
  exit 1
fi

(cd cdk-go && go test ./... >/dev/null)

echo "cdk-go: PASS"
