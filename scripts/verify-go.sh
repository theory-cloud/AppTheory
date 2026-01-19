#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

go test -buildvcs=false ./...
go vet -buildvcs=false ./...

echo "go: PASS"
