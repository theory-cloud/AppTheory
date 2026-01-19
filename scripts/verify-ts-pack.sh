#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

expected_version="$(tr -d ' \t\r\n' < VERSION)"
expected_tgz="theory-cloud-apptheory-${expected_version}.tgz"

mkdir -p dist

rm -f "dist/${expected_tgz}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

tmp_ts_dir="${tmp_dir}/ts"
dist_dir="$(pwd)/dist"

cp -a ts "${tmp_ts_dir}"

if [[ -n "${SOURCE_DATE_EPOCH:-}" ]]; then
  TMP_TS_DIR="${tmp_ts_dir}" python3 - <<'PY'
import os
from pathlib import Path

epoch = int(os.environ["SOURCE_DATE_EPOCH"])
for file_path in Path(os.environ["TMP_TS_DIR"]).rglob("*"):
  if file_path.is_file():
    os.utime(file_path, (epoch, epoch))
PY
fi

(cd "${tmp_ts_dir}" && npm pack --silent --pack-destination "${dist_dir}" >/dev/null)

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
