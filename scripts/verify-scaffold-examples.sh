#!/usr/bin/env bash
# Purpose: verify apptheory-init generated projects with local no-AWS tests and CDK synth.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
repo_root="$PWD"
version="$(./scripts/read-version.sh)"
go_version="${version}"

root_module="$(awk '/^module[[:space:]]+/{print $2; exit}' go.mod)"
version_major="${version%%.*}"
if [[ "${root_module}" =~ /v([2-9][0-9]*)$ ]]; then
  go_module_major="${BASH_REMATCH[1]}"
else
  go_module_major=1
fi
if (( version_major + 1 == go_module_major )); then
  # Release Please still owns the checked-in VERSION while staging prepares
  # the next major semantic import path. Give the synthetic Go scaffold a
  # valid next-major prerelease pin until the generated release PR catches up.
  go_version="${go_module_major}.0.0-rc"
elif (( version_major != go_module_major )); then
  echo "scaffold: FAIL (VERSION major ${version_major} is incompatible with Go module major ${go_module_major})" >&2
  exit 1
fi

for cmd in go node npm python3; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "scaffold: BLOCKED (${cmd} not found)" >&2
    exit 1
  fi
done

mkdir -p .codex/tmp
work_root="$(mktemp -d "${repo_root}/.codex/tmp/apptheory-init.XXXXXX")"
cleanup() {
  rm -rf "${work_root}"
  # The Python scaffold verifies against the real repo-local package. Editable
  # installs can materialize only these generated build metadata paths in the
  # source tree, so cleanup stays explicit and harmless.
  rm -rf "${repo_root}/py/build" "${repo_root}/py/src/apptheory.egg-info"
}
trap cleanup EXIT

patch_package_json() {
  local pkg="$1"
  python3 - "$pkg" "$repo_root" <<'PY'
import json
import pathlib
import sys

pkg_path = pathlib.Path(sys.argv[1])
repo = pathlib.Path(sys.argv[2])
data = json.loads(pkg_path.read_text())
if "dependencies" in data and "@theory-cloud/apptheory" in data["dependencies"]:
    data["dependencies"]["@theory-cloud/apptheory"] = f"file:{repo / 'ts'}"
if "devDependencies" in data and "@theory-cloud/apptheory-cdk" in data["devDependencies"]:
    data["devDependencies"]["@theory-cloud/apptheory-cdk"] = f"file:{repo / 'cdk'}"
pkg_path.write_text(json.dumps(data, indent=2) + "\n")
PY
}

assert_release_pins() {
  local dir="$1"
  local expected_version="${2:-${version}}"
  if ! grep -R "https://github.com/theory-cloud/AppTheory/releases/download/v${expected_version}" "${dir}" >/dev/null; then
    echo "scaffold: FAIL (${dir} does not contain pinned AppTheory release asset URLs for v${expected_version})" >&2
    exit 1
  fi
  if grep -R "__APP_\|__APPTHEORY_" "${dir}" >/dev/null; then
    echo "scaffold: FAIL (${dir} contains unresolved template placeholders)" >&2
    exit 1
  fi
}

synth_project() {
  local dir="$1"
  (cd "${dir}" && npx cdk synth --quiet --no-notices --no-version-reporting -o cdk.out >/dev/null)
}

# Go scaffold.
go_dir="${work_root}/hello-go"
go run ./cmd/apptheory-init --lang=go --version="${go_version}" "${go_dir}" >/dev/null
assert_release_pins "${go_dir}" "${go_version}"
(
  cd "${go_dir}"
  go mod edit -replace github.com/theory-cloud/apptheory/v2="${repo_root}"
  go mod tidy
  go test ./...
  patch_package_json package.json
  npm install >/dev/null
)
synth_project "${go_dir}"

# TypeScript scaffold.
ts_dir="${work_root}/hello-ts"
go run ./cmd/apptheory-init --lang=ts "${ts_dir}" >/dev/null
assert_release_pins "${ts_dir}"
(
  cd "${ts_dir}"
  patch_package_json package.json
  npm install >/dev/null
  npm test
)
synth_project "${ts_dir}"

# Python scaffold.
py_dir="${work_root}/hello-py"
go run ./cmd/apptheory-init --lang=py "${py_dir}" >/dev/null
assert_release_pins "${py_dir}"
(
  cd "${py_dir}"
  printf '%s\n' "${repo_root}/py" > requirements.txt
  PYTHONPATH="${repo_root}/py/src:${py_dir}" python3 -m unittest discover -s tests -p 'test_*.py'
  patch_package_json package.json
  npm install >/dev/null
)
synth_project "${py_dir}"

echo "scaffold: PASS"
