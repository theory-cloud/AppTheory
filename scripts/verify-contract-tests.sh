#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v go >/dev/null 2>&1; then
  echo "contract-tests: BLOCKED (go not found)" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "contract-tests: BLOCKED (node not found)" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "contract-tests: BLOCKED (npm not found)" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "contract-tests: BLOCKED (python3 not found)" >&2
  exit 1
fi

go run ./contract-tests/runners/go

(cd ts && npm ci >/dev/null)

node contract-tests/runners/ts/run.cjs
python3 contract-tests/runners/py/run.py

echo "contract-tests: PASS"
