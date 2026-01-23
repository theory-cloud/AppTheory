#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "ts-lint: BLOCKED (node not found)" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "ts-lint: BLOCKED (npm not found)" >&2
  exit 1
fi
if [[ ! -d "ts" ]]; then
  echo "ts-lint: FAIL (missing ts/)" >&2
  exit 1
fi
if [[ ! -f "ts/package-lock.json" ]]; then
  echo "ts-lint: FAIL (missing ts/package-lock.json)" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
tmp_log="$(mktemp)"
cleanup() {
  rm -rf "${tmp_dir}"
  rm -f "${tmp_log}"
}
trap cleanup EXIT

cp -a ts "${tmp_dir}/ts"

(cd "${tmp_dir}/ts" && npm ci >/dev/null)

if ! (cd "${tmp_dir}/ts" && npm run check >"${tmp_log}" 2>&1); then
  echo "ts-lint: FAIL (ts checks failed)" >&2
  cat "${tmp_log}" >&2
  exit 1
fi

echo "ts-lint: PASS"
