#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "ts-pack: BLOCKED (node not found)" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "ts-pack: BLOCKED (npm not found)" >&2
  exit 1
fi
if [[ ! -d "ts" ]]; then
  echo "ts-pack: FAIL (missing ts/)" >&2
  exit 1
fi
if [[ ! -f "ts/package-lock.json" ]]; then
  echo "ts-pack: FAIL (missing ts/package-lock.json)" >&2
  exit 1
fi

expected_version="$(./scripts/read-version.sh)"
expected_tgz="theory-cloud-apptheory-${expected_version}.tgz"

mkdir -p dist

rm -f "dist/${expected_tgz}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

tmp_ts_dir="${tmp_dir}/ts"
dist_dir="$(pwd)/dist"

cp -a ts "${tmp_ts_dir}"

rm -rf "${tmp_ts_dir}/node_modules"
rm -rf "${tmp_ts_dir}/dist"

(cd "${tmp_ts_dir}" && npm ci >/dev/null)
(cd "${tmp_ts_dir}" && npm run build >/dev/null)

if [[ -n "${SOURCE_DATE_EPOCH:-}" ]]; then
  TMP_TS_DIR="${tmp_ts_dir}" python3 - <<'PY'
import os
from pathlib import Path

epoch = int(os.environ["SOURCE_DATE_EPOCH"])
root = Path(os.environ["TMP_TS_DIR"])

targets = [
  root / "LICENSE",
  root / "README.md",
  root / "package.json",
]

dist = root / "dist"
if dist.is_dir():
  for p in dist.rglob("*"):
    targets.append(p)

for p in targets:
  if p.exists():
    os.utime(p, (epoch, epoch))
PY
fi

(cd "${tmp_ts_dir}" && npm pack --silent --pack-destination "${dist_dir}" >/dev/null)

if [[ ! -f "dist/${expected_tgz}" ]]; then
  echo "ts-pack: FAIL (missing dist/${expected_tgz})"
  exit 1
fi

tar -tf "dist/${expected_tgz}" | grep "^package/dist/index.js$" >/dev/null || {
  echo "ts-pack: FAIL (missing dist/index.js in ${expected_tgz})"
  exit 1
}

tar -tf "dist/${expected_tgz}" | grep "^package/dist/index.d.ts$" >/dev/null || {
  echo "ts-pack: FAIL (missing dist/index.d.ts in ${expected_tgz})"
  exit 1
}

tar -tf "dist/${expected_tgz}" | grep "^package/README.md$" >/dev/null || {
  echo "ts-pack: FAIL (missing README.md in ${expected_tgz})"
  exit 1
}

tar -tf "dist/${expected_tgz}" | grep "^package/LICENSE$" >/dev/null || {
  echo "ts-pack: FAIL (missing LICENSE in ${expected_tgz})"
  exit 1
}

echo "ts-pack: PASS (${expected_tgz})"
