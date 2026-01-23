#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ ! -f "VERSION" ]]; then
  echo "version: FAIL (missing VERSION)" >&2
  exit 1
fi

line="$(head -n 1 VERSION)"
line="${line%%#*}"
version="$(printf "%s" "${line}" | tr -d ' \t\r\n')"

if [[ -z "${version}" ]]; then
  echo "version: FAIL (empty VERSION)" >&2
  exit 1
fi

echo "${version}"
