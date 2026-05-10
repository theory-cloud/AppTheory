#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

exclude_re='(^|/)(node_modules|vendor|dist|build|third_party|testdata)(/|$)'

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  files="$(git ls-files '*.go' | grep -Ev "${exclude_re}" || true)"
else
  files="$(find . -name '*.go' -type f \
    -not -path './node_modules/*' \
    -not -path './vendor/*' \
    -not -path './dist/*' \
    -not -path './build/*' \
    -not -path './third_party/*' \
    -not -path './testdata/*' \
    | sed 's#^\./##' || true)"
fi

if [[ -z "${files}" ]]; then
  exit 0
fi

printf '%s\n' "${files}" \
  | xargs -r -n1 dirname \
  | sort -u \
  | while IFS= read -r dir; do
      if [[ "${dir}" == "." ]]; then
        pkg='.'
      else
        pkg="./${dir#./}"
      fi
      if go list "${pkg}" >/dev/null 2>&1; then
        printf '%s\n' "${pkg}"
      fi
    done
