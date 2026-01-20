#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

tmp="$(mktemp)"
trap 'rm -f "${tmp}"' EXIT

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git ls-files '*.go' > "${tmp}"
else
  find . -name '*.go' -type f \
    -not -path './vendor/*' \
    -not -path './node_modules/*' \
    -not -path './dist/*' \
    -not -path './build/*' \
    -not -path './third_party/*' \
    -not -path './testdata/*' \
    > "${tmp}"
fi
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
