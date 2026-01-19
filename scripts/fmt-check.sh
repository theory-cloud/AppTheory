#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

tmp="$(mktemp)"
trap 'rm -f "${tmp}"' EXIT

git ls-files '*.go' > "${tmp}"
if [[ ! -s "${tmp}" ]]; then
  echo "fmt-check: PASS (no Go files)"
  exit 0
fi

diff="$(gofmt -l $(cat "${tmp}") || true)"
if [[ -n "${diff}" ]]; then
  echo "fmt-check: FAIL (gofmt needed)"
  echo "${diff}"
  exit 1
fi

echo "fmt-check: PASS"

