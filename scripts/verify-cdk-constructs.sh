#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "cdk-constructs: BLOCKED (node not found)" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "cdk-constructs: BLOCKED (npm not found)" >&2
  exit 1
fi
if [[ ! -d "cdk" ]]; then
  echo "cdk-constructs: FAIL (missing cdk/)" >&2
  exit 1
fi

(cd cdk && npm ci >/dev/null)

tmp_log="$(mktemp)"
cleanup() { rm -f "${tmp_log}"; }
trap cleanup EXIT

if ! (cd cdk && npm test >/dev/null 2>"${tmp_log}"); then
  echo "cdk-constructs: FAIL (tests failed)" >&2
  cat "${tmp_log}" >&2
  exit 1
fi

echo "cdk-constructs: PASS"

