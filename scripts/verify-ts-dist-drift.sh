#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "ts-dist-drift: BLOCKED (node not found)" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "ts-dist-drift: BLOCKED (npm not found)" >&2
  exit 1
fi
if [[ ! -d "ts" ]]; then
  echo "ts-dist-drift: FAIL (missing ts/)" >&2
  exit 1
fi
if [[ ! -d "ts/dist" ]]; then
  echo "ts-dist-drift: FAIL (missing checked-in ts/dist/)" >&2
  exit 1
fi
if [[ ! -f "ts/package-lock.json" ]]; then
  echo "ts-dist-drift: FAIL (missing ts/package-lock.json)" >&2
  exit 1
fi

before_diff="$(mktemp)"
after_diff="$(mktemp)"
trap 'rm -f "${before_diff}" "${after_diff}"' EXIT

git diff --binary -- ts/dist >"${before_diff}"

if [[ ! -d "ts/node_modules" ]]; then
  (cd ts && npm ci >/dev/null)
fi

(cd ts && npm run build >/dev/null)

if ! find ts/dist -name '*.js.map' -print -quit | grep -q .; then
  echo "ts-dist-drift: FAIL (missing JavaScript source maps in ts/dist)" >&2
  exit 1
fi
if ! find ts/dist -name '*.d.ts.map' -print -quit | grep -q .; then
  echo "ts-dist-drift: FAIL (missing declaration maps in ts/dist)" >&2
  exit 1
fi

git diff --binary -- ts/dist >"${after_diff}"

if ! cmp -s "${before_diff}" "${after_diff}"; then
  echo "ts-dist-drift: FAIL (ts/dist changes after npm run build)" >&2
  git diff --stat -- ts/dist >&2 || true
  exit 1
fi

echo "ts-dist-drift: PASS"
