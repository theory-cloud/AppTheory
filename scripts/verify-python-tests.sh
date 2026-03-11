#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v python3 >/dev/null 2>&1; then
  echo "python-tests: BLOCKED (python3 not found)" >&2
  exit 1
fi
if [[ ! -d "py" ]]; then
  echo "python-tests: FAIL (missing py/)" >&2
  exit 1
fi
if [[ ! -d "py/tests" ]]; then
  echo "python-tests: FAIL (missing py/tests/)" >&2
  exit 1
fi

if [[ ! -d "py/.venv" ]]; then
  python3 -m venv py/.venv
fi

if ! py/.venv/bin/python -c "import pip" >/dev/null 2>&1; then
  py/.venv/bin/python -m ensurepip --upgrade >/dev/null
fi

py/.venv/bin/python -m pip install --upgrade pip >/dev/null
py/.venv/bin/python -m pip install --editable py >/dev/null

tmp_log="$(mktemp)"
cleanup() {
  rm -f "${tmp_log}"
}
trap cleanup EXIT

if ! PYTHONPATH=py/src py/.venv/bin/python -m unittest discover -s py/tests -p 'test_*.py' >"${tmp_log}" 2>&1; then
  echo "python-tests: FAIL (unit tests failed)" >&2
  cat "${tmp_log}" >&2
  exit 1
fi

echo "python-tests: PASS"
