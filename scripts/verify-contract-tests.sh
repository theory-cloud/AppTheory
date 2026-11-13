#!/usr/bin/env bash
# Purpose: run the shared contract fixture corpus against Go, TypeScript, and Python.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Compose independently produced contract proof when the collector asks for it.
# Any non-applicable record falls through to the real corpus below.
if [[ -n "${APPTHEORY_EVIDENCE_REUSE:-}" ]] && bash scripts/evidence/reuse-if-recorded.sh contract-tests; then
  exit 0
fi

source "scripts/lib/ts-runtime-deps.sh"

./scripts/verify-fixture-schema.sh

if ! command -v go >/dev/null 2>&1; then
  echo "contract-tests: BLOCKED (go not found)" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "contract-tests: BLOCKED (node not found)" >&2
  exit 2
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "contract-tests: BLOCKED (npm not found)" >&2
  exit 2
fi
go run ./contract-tests/runners/go

ensure_ts_runtime_deps_installed

node contract-tests/runners/ts/run.cjs
python3 contract-tests/runners/py/run.py

echo "contract-tests: PASS"
