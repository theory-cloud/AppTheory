#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

expected_version="$(tr -d ' \t\r\n' < VERSION)"

rm -rf dist
mkdir -p dist

if [[ ! -d "py/.venv" ]]; then
  python3 -m venv py/.venv
fi

py/.venv/bin/python -m pip install --upgrade pip >/dev/null
py/.venv/bin/python -m pip install --upgrade build >/dev/null

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

cp -a py "${tmp_dir}/py"

py/.venv/bin/python -m build "${tmp_dir}/py" --outdir dist >/dev/null

if ! ls "dist/apptheory-${expected_version}-"*.whl >/dev/null 2>&1; then
  echo "python-build: FAIL (missing wheel for ${expected_version})"
  exit 1
fi

if [[ ! -f "dist/apptheory-${expected_version}.tar.gz" ]]; then
  echo "python-build: FAIL (missing sdist for ${expected_version})"
  exit 1
fi

echo "python-build: PASS (${expected_version})"
