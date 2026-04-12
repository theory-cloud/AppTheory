#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v npm >/dev/null 2>&1; then
  echo "update-cdk-generated: FAIL (npm not found)" >&2
  exit 1
fi
if ! command -v npx >/dev/null 2>&1; then
  echo "update-cdk-generated: FAIL (npx not found)" >&2
  exit 1
fi
if ! command -v gofmt >/dev/null 2>&1; then
  echo "update-cdk-generated: FAIL (gofmt not found)" >&2
  exit 1
fi
if ! command -v rsync >/dev/null 2>&1; then
  echo "update-cdk-generated: FAIL (rsync not found)" >&2
  exit 1
fi
if [[ ! -d "cdk" ]]; then
  echo "update-cdk-generated: FAIL (missing cdk/)" >&2
  exit 1
fi
if [[ ! -d "cdk-go/apptheorycdk" ]]; then
  echo "update-cdk-generated: FAIL (missing cdk-go/apptheorycdk/)" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

(cd cdk && npm ci >/dev/null)
(cd cdk && npm run build >/dev/null)
(cd cdk && npx jsii-pacmak -t go --code-only -o "${tmp_dir}" --force-subdirectory false --force >/dev/null)

if [[ ! -d "${tmp_dir}/apptheorycdk" ]]; then
  echo "update-cdk-generated: FAIL (jsii-pacmak did not generate apptheorycdk/)" >&2
  exit 1
fi

rsync -a --delete --exclude go.mod --exclude generated_sync_test.go "${tmp_dir}/apptheorycdk/" "cdk-go/apptheorycdk/"
find cdk-go/apptheorycdk -type f -name '*.go' -print0 | xargs -0 gofmt -w

echo "update-cdk-generated: PASS"
