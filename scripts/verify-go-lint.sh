#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v golangci-lint >/dev/null 2>&1; then
  echo "go-lint: FAIL (missing golangci-lint; install pinned: go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.5.0)"
  exit 1
fi

golangci-lint run --timeout=5m --config .golangci-v2.yml ./...

echo "go-lint: PASS"

