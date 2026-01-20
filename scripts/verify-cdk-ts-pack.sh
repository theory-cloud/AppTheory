#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

expected_version="$(tr -d ' \t\r\n' < VERSION)"
expected_tgz="theory-cloud-apptheory-cdk-${expected_version}.tgz"

mkdir -p dist

rm -f "dist/${expected_tgz}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

tmp_cdk_dir="${tmp_dir}/cdk"
dist_dir="$(pwd)/dist"

cp -a cdk "${tmp_cdk_dir}"

if [[ -n "${SOURCE_DATE_EPOCH:-}" ]]; then
  TMP_DIR="${tmp_cdk_dir}" python3 - <<'PY'
import os
from pathlib import Path

epoch = int(os.environ["SOURCE_DATE_EPOCH"])
for file_path in Path(os.environ["TMP_DIR"]).rglob("*"):
  if file_path.is_file():
    os.utime(file_path, (epoch, epoch))
PY
fi

(cd "${tmp_cdk_dir}" && npm ci >/dev/null)
(cd "${tmp_cdk_dir}" && npm run build >/dev/null)

if [[ -n "${SOURCE_DATE_EPOCH:-}" ]]; then
  TMP_DIR="${tmp_cdk_dir}" python3 - <<'PY'
import os
from pathlib import Path

epoch = int(os.environ["SOURCE_DATE_EPOCH"])
for file_path in Path(os.environ["TMP_DIR"]).rglob("*"):
  if file_path.is_file():
    os.utime(file_path, (epoch, epoch))
PY
fi

(cd "${tmp_cdk_dir}" && npm pack --silent --pack-destination "${dist_dir}" >/dev/null)

if [[ ! -f "dist/${expected_tgz}" ]]; then
  echo "cdk-ts-pack: FAIL (missing dist/${expected_tgz})"
  exit 1
fi

tar -tf "dist/${expected_tgz}" | grep "^package/lib/index.js$" >/dev/null || {
  echo "cdk-ts-pack: FAIL (missing lib/index.js in ${expected_tgz})"
  exit 1
}

tar -tf "dist/${expected_tgz}" | grep "^package/lib/index.d.ts$" >/dev/null || {
  echo "cdk-ts-pack: FAIL (missing lib/index.d.ts in ${expected_tgz})"
  exit 1
}

tar -tf "dist/${expected_tgz}" | grep "^package/\\.jsii$" >/dev/null || {
  echo "cdk-ts-pack: FAIL (missing .jsii in ${expected_tgz})"
  exit 1
}

tar -tf "dist/${expected_tgz}" | grep "^package/LICENSE$" >/dev/null || {
  echo "cdk-ts-pack: FAIL (missing LICENSE in ${expected_tgz})"
  exit 1
}

echo "cdk-ts-pack: PASS (${expected_tgz})"
