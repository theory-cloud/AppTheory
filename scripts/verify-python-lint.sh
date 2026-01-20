#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v python3 >/dev/null 2>&1; then
  echo "python-lint: BLOCKED (python3 not found)" >&2
  exit 1
fi
if [[ ! -d "py" ]]; then
  echo "python-lint: FAIL (missing py/)" >&2
  exit 1
fi
if [[ ! -f "py/requirements-lint.txt" ]]; then
  echo "python-lint: FAIL (missing py/requirements-lint.txt)" >&2
  exit 1
fi

if [[ ! -d "py/.venv" ]]; then
  python3 -m venv py/.venv
fi

py/.venv/bin/python -m pip install --upgrade pip >/dev/null
py/.venv/bin/python -m pip install --requirement py/requirements-lint.txt >/dev/null

py/.venv/bin/ruff check py/src
py/.venv/bin/ruff format --check py/src

echo "python-lint: PASS"

