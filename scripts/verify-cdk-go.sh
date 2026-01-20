#!/usr/bin/env bash
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

(cd cdk-go/apptheorycdk && go test ./... >/dev/null)

echo "cdk-go: PASS"

