#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "examples: BLOCKED (node not found)" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "examples: BLOCKED (python3 not found)" >&2
  exit 1
fi

node examples/testkit/ts.mjs
python3 examples/testkit/py.py

echo "examples: PASS"

