#!/usr/bin/env bash
# Purpose: run the cross-language unit suite as one schedulable gate.
#
# This is the QUA-1 unit selection moved out of the monolithic rubric so the
# collector can execute it once and let the rubric compose the recorded result.
# The Go portion composes the separately recorded Go gate when the collector
# asks for it; TypeScript and Python tests are distinct environments and run
# here.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

blocked() {
  echo "unit: BLOCKED ($1)" >&2
  exit 2
}

for tool in go node npm python3; do
  command -v "${tool}" >/dev/null 2>&1 || blocked "missing required command: ${tool}"
done

go_covered=false
if [[ -n "${APPTHEORY_EVIDENCE_REUSE:-}" ]] && bash scripts/evidence/reuse-if-recorded.sh go; then
  go_covered=true
fi

if [[ "${go_covered}" != "true" ]]; then
  # QUA-1 runs the root-module unit packages, excluding the Go contract runner
  # (CON-3 runs the direct corpus once), then runs the runner's meta-tests with
  # only the full-corpus test skipped.
  mapfile -t go_unit_pkgs < <(./scripts/list-go-packages.sh | grep -Ev '^\./contract-tests/runners/go$')
  if [[ "${#go_unit_pkgs[@]}" -eq 0 ]]; then
    echo "unit: FAIL (no Go packages selected for unit tests)" >&2
    exit 1
  fi
  go test "${go_unit_pkgs[@]}"
  go test ./contract-tests/runners/go -skip '^TestAllFixturesPass$'
else
  echo "unit: Go portion composed from the verified go gate"
fi

source "scripts/lib/ts-runtime-deps.sh"
ensure_ts_runtime_deps_installed
scripts/verify-ts-tests.sh

scripts/verify-python-tests.sh

echo "unit: PASS"
