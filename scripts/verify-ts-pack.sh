#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

expected_version="$(tr -d ' \t\r\n' < VERSION)"
expected_tgz="theory-cloud-apptheory-${expected_version}.tgz"

rm -rf dist
mkdir -p dist

(cd ts && npm pack --silent --pack-destination ../dist >/dev/null)

if [[ ! -f "dist/${expected_tgz}" ]]; then
  echo "ts-pack: FAIL (missing dist/${expected_tgz})"
  exit 1
fi

tar -tf "dist/${expected_tgz}" | grep -q "^package/dist/index.js$" || {
  echo "ts-pack: FAIL (missing dist/index.js in ${expected_tgz})"
  exit 1
}

tar -tf "dist/${expected_tgz}" | grep -q "^package/dist/index.d.ts$" || {
  echo "ts-pack: FAIL (missing dist/index.d.ts in ${expected_tgz})"
  exit 1
}

tar -tf "dist/${expected_tgz}" | grep -q "^package/README.md$" || {
  echo "ts-pack: FAIL (missing README.md in ${expected_tgz})"
  exit 1
}

echo "ts-pack: PASS (${expected_tgz})"

