#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

snapshot_dir="api-snapshots"

if [[ ! -d "${snapshot_dir}" ]]; then
  echo "api-snapshots: FAIL (missing ${snapshot_dir}/)" >&2
  echo "api-snapshots: run ./scripts/update-api-snapshots.sh to create baseline snapshots" >&2
  exit 1
fi

required=(
  "go.txt"
  "ts.txt"
  "py.txt"
)

for f in "${required[@]}"; do
  if [[ ! -f "${snapshot_dir}/${f}" ]]; then
    echo "api-snapshots: FAIL (missing ${snapshot_dir}/${f})" >&2
    echo "api-snapshots: run ./scripts/update-api-snapshots.sh to regenerate snapshots" >&2
    exit 1
  fi
done

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

./scripts/generate-api-snapshots.sh "${tmp_dir}" >/dev/null

fail=0
for f in "${required[@]}"; do
  if ! diff -u "${snapshot_dir}/${f}" "${tmp_dir}/${f}" >/dev/null; then
    echo "api-snapshots: FAIL (drift detected: ${snapshot_dir}/${f})" >&2
    diff -u "${snapshot_dir}/${f}" "${tmp_dir}/${f}" >&2 || true
    fail=1
  fi
done

if [[ "${fail}" -ne 0 ]]; then
  echo "api-snapshots: re-run ./scripts/update-api-snapshots.sh and commit changes if intentional" >&2
  exit 1
fi

echo "api-snapshots: PASS"

