#!/usr/bin/env bash
# Purpose: regenerate checked-in jsii Go bindings for the CDK construct package.
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
if ! command -v go >/dev/null 2>&1; then
  echo "update-cdk-generated: FAIL (go not found)" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "update-cdk-generated: FAIL (python3 not found)" >&2
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
for handwritten_test in bindings_test.go generated_sync_test.go; do
  if [[ ! -f "cdk-go/apptheorycdk/${handwritten_test}" ]]; then
    echo "update-cdk-generated: FAIL (missing handwritten cdk-go/apptheorycdk/${handwritten_test})" >&2
    exit 1
  fi
done

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
if [[ ! -f "${tmp_dir}/apptheorycdk/go.mod" ]]; then
  echo "update-cdk-generated: FAIL (jsii-pacmak did not generate apptheorycdk/go.mod)" >&2
  exit 1
fi

generated_root="${tmp_dir}/apptheorycdk"
generated_module="$(awk '/^module[[:space:]]+/{print $2; exit}' "${generated_root}/go.mod")"
cdk_version="$(
  python3 - <<'PY'
import json
from pathlib import Path

data = json.loads(Path("cdk/package.json").read_text(encoding="utf-8"))
print(data.get("version", ""))
PY
)"
if [[ ! "${cdk_version}" =~ ^([0-9]+)\.[0-9]+\.[0-9]+(-rc(\.[0-9]+)?)?$ ]]; then
  echo "update-cdk-generated: FAIL (unsupported cdk/package.json version '${cdk_version}')" >&2
  exit 1
fi
cdk_major="${BASH_REMATCH[1]}"

legacy_module="github.com/theory-cloud/apptheory/cdk-go"
generated_module_base="${legacy_module}/apptheorycdk"
destination="cdk-go/apptheorycdk"

for handwritten_test in bindings_test.go generated_sync_test.go; do
  cp "${destination}/${handwritten_test}" "${tmp_dir}/${handwritten_test}"
done

if [[ "${generated_module}" == "${generated_module_base}" ]]; then
  if (( cdk_major != 1 )); then
    echo "update-cdk-generated: FAIL (CDK ${cdk_version} generated unsuffixed module '${generated_module}')" >&2
    exit 1
  fi
  if [[ ! -f "cdk-go/go.mod" ]]; then
    echo "update-cdk-generated: FAIL (legacy jsii output requires cdk-go/go.mod)" >&2
    exit 1
  fi
  if [[ -f "${destination}/go.mod" ]]; then
    echo "update-cdk-generated: FAIL (legacy jsii output must not coexist with ${destination}/go.mod)" >&2
    exit 1
  fi

  rsync -a --delete \
    --exclude go.mod \
    --exclude go.sum \
    --exclude bindings_test.go \
    --exclude generated_sync_test.go \
    "${generated_root}/" \
    "${destination}/"
  module_root="cdk-go"
elif [[ "${generated_module}" =~ ^github\.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v([2-9][0-9]*)$ ]]; then
  generated_major="${BASH_REMATCH[1]}"
  if (( generated_major != cdk_major )); then
    echo "update-cdk-generated: FAIL (CDK major ${cdk_major} generated module major ${generated_major})" >&2
    exit 1
  fi
  expected_module="${generated_module_base}/v${generated_major}"
  if [[ "${generated_module}" != "${expected_module}" ]]; then
    echo "update-cdk-generated: FAIL (generated module '${generated_module}' != '${expected_module}')" >&2
    exit 1
  fi

  rsync -a --delete \
    --exclude bindings_test.go \
    --exclude generated_sync_test.go \
    "${generated_root}/" \
    "${destination}/"
  rm -f cdk-go/go.mod cdk-go/go.sum
  module_root="${destination}"
else
  echo "update-cdk-generated: FAIL (unsupported jsii Go module '${generated_module}')" >&2
  exit 1
fi

for handwritten_test in bindings_test.go generated_sync_test.go; do
  if ! cmp -s "${tmp_dir}/${handwritten_test}" "${destination}/${handwritten_test}"; then
    echo "update-cdk-generated: FAIL (regeneration changed handwritten ${destination}/${handwritten_test})" >&2
    exit 1
  fi
done

find "${destination}" -type f -name '*.go' -print0 | xargs -0 gofmt -w
(cd "${module_root}" && go mod tidy >/dev/null)

echo "update-cdk-generated: PASS (${generated_module})"
