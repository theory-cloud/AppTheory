#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

mapfile -t go_packages < <(./scripts/list-go-packages.sh)
if [[ ${#go_packages[@]} -eq 0 ]]; then
  echo "go: FAIL (no tracked Go packages found)" >&2
  exit 1
fi

go test -buildvcs=false "${go_packages[@]}"
go vet -buildvcs=false "${go_packages[@]}"

echo "go: PASS"
