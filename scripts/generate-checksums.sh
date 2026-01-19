#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ ! -d "dist" ]]; then
  echo "checksums: FAIL (missing dist/)"
  exit 1
fi

checksum_file="SHA256SUMS.txt"

(
  cd dist

  files="$(find . -maxdepth 1 -type f ! -name "${checksum_file}" -printf '%f\n' | sort)"
  if [[ -z "${files}" ]]; then
    echo "checksums: FAIL (no artifacts found in dist/)"
    exit 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum ${files} > "${checksum_file}"
  else
    shasum -a 256 ${files} > "${checksum_file}"
  fi
)

echo "checksums: PASS (dist/${checksum_file})"

