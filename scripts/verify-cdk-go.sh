#!/usr/bin/env bash
# Purpose: verify the generated CDK Go binding package compiles and tests.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v go >/dev/null 2>&1; then
  echo "cdk-go: BLOCKED (go not found)" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "cdk-go: BLOCKED (python3 not found)" >&2
  exit 1
fi
if [[ ! -d "cdk-go/apptheorycdk" ]]; then
  echo "cdk-go: FAIL (missing cdk-go/apptheorycdk)" >&2
  exit 1
fi
if [[ ! -f "cdk/package.json" ]]; then
  echo "cdk-go: FAIL (missing cdk/package.json)" >&2
  exit 1
fi

cdk_version="$(
  python3 - <<'PY'
import json
from pathlib import Path

data = json.loads(Path("cdk/package.json").read_text(encoding="utf-8"))
print(data.get("version", ""))
PY
)"
if [[ ! "${cdk_version}" =~ ^([0-9]+)\.[0-9]+\.[0-9]+(-rc(\.[0-9]+)?)?$ ]]; then
  echo "cdk-go: FAIL (unsupported cdk/package.json version '${cdk_version}')" >&2
  exit 1
fi

cdk_major="${BASH_REMATCH[1]}"
legacy_go_mod="cdk-go/go.mod"
canonical_go_mod="cdk-go/apptheorycdk/go.mod"
legacy_module="github.com/theory-cloud/apptheory/cdk-go"

if (( cdk_major == 1 )); then
  module_root="cdk-go"
  go_mod="${legacy_go_mod}"
  expected_module="${legacy_module}"
  if [[ -f "${canonical_go_mod}" ]]; then
    echo "cdk-go: FAIL (v1 layout must not contain ${canonical_go_mod})" >&2
    exit 1
  fi
else
  module_root="cdk-go/apptheorycdk"
  go_mod="${canonical_go_mod}"
  expected_module="${legacy_module}/apptheorycdk/v${cdk_major}"
  if [[ -f "${legacy_go_mod}" || -f "cdk-go/go.sum" ]]; then
    echo "cdk-go: FAIL (v${cdk_major} layout must not retain legacy cdk-go/go.mod or cdk-go/go.sum)" >&2
    exit 1
  fi
fi

if [[ ! -f "${go_mod}" ]]; then
  echo "cdk-go: FAIL (missing ${go_mod} for CDK ${cdk_version})" >&2
  exit 1
fi

observed_module="$(awk '/^module[[:space:]]+/{print $2; exit}' "${go_mod}")"
if [[ "${observed_module}" != "${expected_module}" ]]; then
  echo "cdk-go: FAIL (${go_mod} module '${observed_module}' != '${expected_module}')" >&2
  exit 1
fi

for handwritten_test in bindings_test.go generated_sync_test.go; do
  if [[ ! -f "cdk-go/apptheorycdk/${handwritten_test}" ]]; then
    echo "cdk-go: FAIL (missing handwritten cdk-go/apptheorycdk/${handwritten_test})" >&2
    exit 1
  fi
done

(cd "${module_root}" && go test ./... >/dev/null)

echo "cdk-go: PASS (${observed_module})"
