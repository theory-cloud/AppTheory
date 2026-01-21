#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

out_dir="${1:-}"
if [[ -z "${out_dir}" ]]; then
  echo "usage: scripts/generate-api-snapshots.sh <out-dir>" >&2
  exit 1
fi

if ! command -v go >/dev/null 2>&1; then
  echo "api-snapshots: BLOCKED (go not found)" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "api-snapshots: BLOCKED (python3 not found)" >&2
  exit 1
fi

if [[ ! -f "ts/dist/index.d.ts" ]]; then
  echo "api-snapshots: FAIL (missing ts/dist/index.d.ts)" >&2
  exit 1
fi
if [[ ! -f "py/src/apptheory/__init__.py" ]]; then
  echo "api-snapshots: FAIL (missing py/src/apptheory/__init__.py)" >&2
  exit 1
fi

mkdir -p "${out_dir}"

go run ./scripts/tools/api_snapshots/go > "${out_dir}/go.txt"
python3 ./scripts/tools/api_snapshots/ts_snapshot.py "ts/dist/index.d.ts" > "${out_dir}/ts.txt"
python3 ./scripts/tools/api_snapshots/py_snapshot.py "py/src/apptheory/__init__.py" > "${out_dir}/py.txt"

echo "api-snapshots: generated (${out_dir})"

