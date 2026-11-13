#!/usr/bin/env bash
# Purpose: run root-module Go tests and vet checks.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Compose an independently produced result when the collector asks for it. The
# helper verifies the exact inputs and never executes a recorded command; if the
# record is not applicable this script runs the real gate below.
if [[ -n "${APPTHEORY_EVIDENCE_REUSE:-}" ]] && bash scripts/evidence/reuse-if-recorded.sh go; then
  exit 0
fi

mapfile -t go_packages < <(./scripts/list-go-packages.sh)
if [[ ${#go_packages[@]} -eq 0 ]]; then
  echo "go: FAIL (no tracked Go packages found)" >&2
  exit 1
fi

go test -buildvcs=false "${go_packages[@]}"
go vet -buildvcs=false "${go_packages[@]}"

echo "go: PASS"
