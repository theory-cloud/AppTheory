#!/usr/bin/env bash
# Purpose: verify all release-managed version files and manifests match VERSION.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "--self-test" ]]; then
  tmp_dir="$(mktemp -d)"
  cleanup() {
    rm -rf "${tmp_dir}"
  }
  trap cleanup EXIT

  copy_fixture() {
    local fixture_dir="$1"

    mkdir -p "${fixture_dir}/scripts" "${fixture_dir}/ts" "${fixture_dir}/cdk" \
      "${fixture_dir}/cdk-go/apptheorycdk" "${fixture_dir}/py" "${fixture_dir}/examples/cdk"
    cp VERSION go.mod .release-please-manifest.json .release-please-manifest.premain.json \
      release-please-config.json release-please-config.premain.json "${fixture_dir}/"
    if [[ -f "cdk-go/go.mod" ]]; then
      cp cdk-go/go.mod "${fixture_dir}/cdk-go/"
    fi
    if [[ -f "cdk-go/apptheorycdk/go.mod" ]]; then
      cp cdk-go/apptheorycdk/go.mod "${fixture_dir}/cdk-go/apptheorycdk/"
    fi
    cp scripts/read-version.sh scripts/verify-version-alignment.sh "${fixture_dir}/scripts/"
    cp ts/package.json ts/package-lock.json "${fixture_dir}/ts/"
    cp cdk/package.json cdk/package-lock.json cdk/.jsii "${fixture_dir}/cdk/"
    cp py/pyproject.toml "${fixture_dir}/py/"
    while IFS= read -r lockfile; do
      mkdir -p "${fixture_dir}/$(dirname "${lockfile}")"
      cp "${lockfile}" "${fixture_dir}/${lockfile}"
    done < <(find examples/cdk -maxdepth 2 -name package-lock.json -print | sort)
  }

  write_version_state() {
    local fixture_dir="$1"
    local version="$2"
    local stable_manifest="$3"
    local premain_manifest="$4"

    python3 - "${fixture_dir}" "${version}" "${stable_manifest}" "${premain_manifest}" <<'PY'
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
version = sys.argv[2]
stable_manifest = sys.argv[3]
premain_manifest = sys.argv[4]

root.joinpath("VERSION").write_text(f"{version} # x-release-please-version\n", encoding="utf-8")
root.joinpath(".release-please-manifest.json").write_text(
    json.dumps({".": stable_manifest}, indent=2) + "\n", encoding="utf-8"
)
root.joinpath(".release-please-manifest.premain.json").write_text(
    json.dumps({".": premain_manifest}, indent=2) + "\n", encoding="utf-8"
)

for rel in ("ts/package.json", "ts/package-lock.json", "cdk/package.json", "cdk/package-lock.json", "cdk/.jsii"):
    path = root / rel
    data = json.loads(path.read_text(encoding="utf-8"))
    data["version"] = version
    packages = data.get("packages")
    if isinstance(packages, dict) and isinstance(packages.get(""), dict):
        packages[""]["version"] = version
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

for lock_path in root.glob("examples/cdk/*/package-lock.json"):
    data = json.loads(lock_path.read_text(encoding="utf-8"))
    packages = data.get("packages")
    cdk_package = packages.get("../../../cdk") if isinstance(packages, dict) else None
    if isinstance(cdk_package, dict) and "version" in cdk_package:
        cdk_package["version"] = version
        lock_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

pyproject = root.joinpath("py/pyproject.toml")
text = pyproject.read_text(encoding="utf-8")
text, count = re.subn(r'(?m)^version = "[^"]+"', f'version = "{version}"', text, count=1)
if count != 1:
    raise SystemExit("could not update py/pyproject.toml version")
pyproject.write_text(text, encoding="utf-8")

version_major = int(version.split(".", 1)[0])
legacy_path = root / "cdk-go" / "go.mod"
canonical_path = root / "cdk-go" / "apptheorycdk" / "go.mod"
source_path = canonical_path if canonical_path.is_file() else legacy_path
module_text = source_path.read_text(encoding="utf-8")
expected_cdk_module = "github.com/theory-cloud/apptheory/cdk-go"
target_path = legacy_path
stale_path = canonical_path
if version_major >= 2:
    expected_cdk_module += f"/apptheorycdk/v{version_major}"
    target_path = canonical_path
    stale_path = legacy_path
module_text, count = re.subn(
    r"(?m)^module\s+\S+$",
    f"module {expected_cdk_module}",
    module_text,
    count=1,
)
if count != 1:
    raise SystemExit("could not update synthetic cdk-go module declaration")
target_path.parent.mkdir(parents=True, exist_ok=True)
target_path.write_text(module_text, encoding="utf-8")
if stale_path.exists():
    stale_path.unlink()
PY
  }

  run_self_test_case() {
    local label="$1"
    local fixture_dir="$2"
    local expected_exit="$3"
    local expected_output="$4"
    local output
    local status

    set +e
    output="$(cd "${fixture_dir}" && bash scripts/verify-version-alignment.sh 2>&1)"
    status=$?
    set -e

    if [[ "${status}" != "${expected_exit}" ]]; then
      echo "version-alignment-self-test: FAIL (${label}; expected exit ${expected_exit}, got ${status})" >&2
      echo "${output}" >&2
      exit 1
    fi
    if [[ "${output}" != *"${expected_output}"* ]]; then
      echo "version-alignment-self-test: FAIL (${label}; missing ${expected_output@Q})" >&2
      echo "${output}" >&2
      exit 1
    fi
  }

  jsii_skew_dir="${tmp_dir}/jsii-skew"
  copy_fixture "${jsii_skew_dir}"
  python3 - "${jsii_skew_dir}/cdk/.jsii" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8"))
data["version"] = "0.0.0-self-test"
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
  run_self_test_case "deliberate cdk/.jsii skew" "${jsii_skew_dir}" 1 "cdk/.jsii"

  prerelease_split_dir="${tmp_dir}/prerelease-split"
  copy_fixture "${prerelease_split_dir}"
  write_version_state "${prerelease_split_dir}" "1.16.0-rc" "1.15.2" "1.16.0-rc"
  run_self_test_case "prerelease manifest split" "${prerelease_split_dir}" 0 "version-alignment: PASS (1.16.0-rc)"

  wrong_premain_dir="${tmp_dir}/wrong-premain"
  copy_fixture "${wrong_premain_dir}"
  write_version_state "${wrong_premain_dir}" "1.16.0-rc" "1.15.2" "1.15.2"
  run_self_test_case "wrong prerelease premain manifest" "${wrong_premain_dir}" 1 ".release-please-manifest.premain.json"

  stable_manifest_skew_dir="${tmp_dir}/stable-manifest-skew"
  copy_fixture "${stable_manifest_skew_dir}"
  write_version_state "${stable_manifest_skew_dir}" "1.16.0" "1.15.2" "1.16.0"
  run_self_test_case "stable manifest skew" "${stable_manifest_skew_dir}" 1 ".release-please-manifest.json"

  released_v2_dir="${tmp_dir}/released-v2"
  copy_fixture "${released_v2_dir}"
  write_version_state "${released_v2_dir}" "2.0.0-rc" "1.17.1" "2.0.0-rc"
  run_self_test_case "released v2 module" "${released_v2_dir}" 0 \
    "go module state released-major (github.com/theory-cloud/apptheory/v2; VERSION 2.0.0-rc)"

  legacy_cdk_in_v2_dir="${tmp_dir}/legacy-cdk-in-v2"
  copy_fixture "${legacy_cdk_in_v2_dir}"
  write_version_state "${legacy_cdk_in_v2_dir}" "2.0.0-rc" "1.17.1" "2.0.0-rc"
  cp \
    "${legacy_cdk_in_v2_dir}/cdk-go/apptheorycdk/go.mod" \
    "${legacy_cdk_in_v2_dir}/cdk-go/go.mod"
  run_self_test_case "legacy CDK module retained in v2" "${legacy_cdk_in_v2_dir}" 1 \
    "must not retain legacy cdk-go/go.mod or cdk-go/go.sum"

  nested_cdk_in_v1_dir="${tmp_dir}/nested-cdk-in-v1"
  copy_fixture "${nested_cdk_in_v1_dir}"
  cp \
    "${nested_cdk_in_v1_dir}/cdk-go/go.mod" \
    "${nested_cdk_in_v1_dir}/cdk-go/apptheorycdk/go.mod"
  run_self_test_case "nested CDK module introduced in v1" "${nested_cdk_in_v1_dir}" 1 \
    "must not use cdk-go/apptheorycdk/go.mod"

  wrong_module_dir="${tmp_dir}/wrong-module"
  copy_fixture "${wrong_module_dir}"
  python3 - "${wrong_module_dir}/go.mod" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
path.write_text(
    text.replace(
        "module github.com/theory-cloud/apptheory/v2\n",
        "module github.com/theory-cloud/apptheory\n",
        1,
    ),
    encoding="utf-8",
)
PY
  run_self_test_case "unsuffixed root module" "${wrong_module_dir}" 1 \
    "go.mod module 'github.com/theory-cloud/apptheory' != 'github.com/theory-cloud/apptheory/v2'"

  wrong_module_major_dir="${tmp_dir}/wrong-module-major"
  copy_fixture "${wrong_module_major_dir}"
  write_version_state "${wrong_module_major_dir}" "3.0.0" "3.0.0" "3.0.0"
  run_self_test_case "unsupported VERSION major" "${wrong_module_major_dir}" 1 \
    "VERSION major 3 is incompatible with Go module major 2"

  stale_import_dir="${tmp_dir}/stale-import"
  copy_fixture "${stale_import_dir}"
  mkdir -p "${stale_import_dir}/runtime"
  cat > "${stale_import_dir}/runtime/stale.go" <<'GO'
package runtime

import "github.com/theory-cloud/apptheory/testkit"
GO
  run_self_test_case "unsuffixed active import" "${stale_import_dir}" 1 \
    "runtime/stale.go:3: unsuffixed root module reference"

  echo "version-alignment-self-test: PASS"
  exit 0
fi

expected_module="github.com/theory-cloud/apptheory/v2"
expected_module_major=2

if [[ ! -f "VERSION" ]]; then
  echo "version-alignment: FAIL (missing VERSION)"
  exit 1
fi

expected_version="$(./scripts/read-version.sh)"
if [[ -z "${expected_version}" ]]; then
  echo "version-alignment: FAIL (empty VERSION)"
  exit 1
fi

if [[ ! "${expected_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc(\.[0-9]+)?)?$ ]]; then
  echo "version-alignment: FAIL (VERSION '${expected_version}' must match X.Y.Z, X.Y.Z-rc, or X.Y.Z-rc.N)"
  exit 1
fi

expected_version_major="${expected_version%%.*}"
if (( expected_version_major == expected_module_major )); then
  go_module_state="released-major"
elif (( expected_version_major + 1 == expected_module_major )); then
  # Release Please owns VERSION. During an approved major-version migration,
  # staging carries the next major's semantic import path before the generated
  # release PR advances VERSION and the language package manifests.
  go_module_state="staged-next-major"
else
  echo "version-alignment: FAIL (VERSION major ${expected_version_major} is incompatible with Go module major ${expected_module_major})"
  exit 1
fi

if [[ ! -f "go.mod" ]]; then
  echo "version-alignment: FAIL (missing go.mod)"
  exit 1
fi

observed_module="$(awk '/^module[[:space:]]+/{print $2; exit}' go.mod || true)"
if [[ "${observed_module}" != "${expected_module}" ]]; then
  echo "version-alignment: FAIL (go.mod module '${observed_module}' != '${expected_module}')"
  exit 1
fi
echo "version-alignment: go module state ${go_module_state} (${expected_module}; VERSION ${expected_version})"

python3 - <<'PY'
import sys
from pathlib import Path

root_module = "github.com/theory-cloud/apptheory"
allowed_suffixes = ("/v2", "/cdk-go")
skip_parts = {
    ".git",
    ".jekyll-cache",
    "_site",
    "cdk.out",
    "dist",
    "node_modules",
}
candidate_paths = {
    Path(".golangci-v2.yml"),
    Path("README.md"),
    Path("api-snapshots/go.txt"),
    Path("go.mod"),
    Path("scripts/verify-scaffold-examples.sh"),
}
for root in (
    Path("cmd"),
    Path("contract-tests/runners/go"),
    Path("docs"),
    Path("examples"),
    Path("pkg"),
    Path("runtime"),
    Path("scripts/tools/api_snapshots/go"),
    Path("templates/apptheory-init/go"),
    Path("testkit"),
):
    if not root.exists():
        continue
    for path in root.rglob("*"):
        if not path.is_file() or skip_parts.intersection(path.parts):
            continue
        if path.parts[:3] == ("docs", "development", "planning"):
            continue
        candidate_paths.add(path)

errors: list[str] = []
boundary = set("/@=`\"' \t\r\n)")
for path in sorted(candidate_paths):
    if not path.exists():
        continue
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue
    for line_number, line in enumerate(text.splitlines(), start=1):
        offset = 0
        while True:
            index = line.find(root_module, offset)
            if index < 0:
                break
            suffix = line[index + len(root_module):]
            allowed = any(
                suffix.startswith(prefix)
                and (
                    len(suffix) == len(prefix)
                    or suffix[len(prefix)] in boundary
                )
                for prefix in allowed_suffixes
            )
            if not allowed and (not suffix or suffix[0] in boundary):
                errors.append(f"{path}:{line_number}: unsuffixed root module reference")
            offset = index + len(root_module)

if errors:
    print("version-alignment: FAIL (Go semantic import version hygiene)", file=sys.stderr)
    for error in errors:
        print(f"- {error}", file=sys.stderr)
    sys.exit(1)
PY

legacy_cdk_go_mod="cdk-go/go.mod"
canonical_cdk_go_mod="cdk-go/apptheorycdk/go.mod"
if (( expected_version_major == 1 )); then
  expected_cdk_go_mod="${legacy_cdk_go_mod}"
  expected_cdk_go_module="github.com/theory-cloud/apptheory/cdk-go"
  if [[ -f "${canonical_cdk_go_mod}" ]]; then
    echo "version-alignment: FAIL (VERSION ${expected_version} must not use ${canonical_cdk_go_mod})"
    exit 1
  fi
else
  expected_cdk_go_mod="${canonical_cdk_go_mod}"
  expected_cdk_go_module="github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v${expected_version_major}"
  if [[ -f "${legacy_cdk_go_mod}" || -f "cdk-go/go.sum" ]]; then
    echo "version-alignment: FAIL (VERSION ${expected_version} must not retain legacy cdk-go/go.mod or cdk-go/go.sum)"
    exit 1
  fi
fi

if [[ ! -f "${expected_cdk_go_mod}" ]]; then
  echo "version-alignment: FAIL (missing ${expected_cdk_go_mod})"
  exit 1
fi

observed_cdk_go_module="$(awk '/^module[[:space:]]+/{print $2; exit}' "${expected_cdk_go_mod}" || true)"
if [[ "${observed_cdk_go_module}" != "${expected_cdk_go_module}" ]]; then
  echo "version-alignment: FAIL (${expected_cdk_go_mod} module '${observed_cdk_go_module}' != '${expected_cdk_go_module}')"
  exit 1
fi

if [[ ! -f "ts/package.json" ]]; then
  echo "version-alignment: FAIL (missing ts/package.json)"
  exit 1
fi

ts_version="$(
  python3 - <<'PY'
import json
from pathlib import Path

data = json.loads(Path("ts/package.json").read_text(encoding="utf-8"))
print(data.get("version", ""))
PY
)"

if [[ -z "${ts_version}" ]]; then
  echo "version-alignment: FAIL (ts/package.json missing version)"
  exit 1
fi

if [[ "${ts_version}" != "${expected_version}" ]]; then
  echo "version-alignment: FAIL (ts/package.json ${ts_version} != ${expected_version})"
  exit 1
fi

if [[ -f "ts/package-lock.json" ]]; then
  lock_version="$(
    python3 - <<'PY'
import json
from pathlib import Path

data = json.loads(Path("ts/package-lock.json").read_text(encoding="utf-8"))
print(data.get("version", ""))
PY
  )"

  pkg_lock_version="$(
    python3 - <<'PY'
import json
from pathlib import Path

data = json.loads(Path("ts/package-lock.json").read_text(encoding="utf-8"))
packages = data.get("packages", {})
root = packages.get("", {}) if isinstance(packages, dict) else {}
print(root.get("version", ""))
PY
  )"

  if [[ "${lock_version}" != "${expected_version}" ]]; then
    echo "version-alignment: FAIL (ts/package-lock.json ${lock_version} != ${expected_version})"
    exit 1
  fi

  if [[ "${pkg_lock_version}" != "${expected_version}" ]]; then
    echo "version-alignment: FAIL (ts/package-lock.json packages[''].version ${pkg_lock_version} != ${expected_version})"
    exit 1
  fi
fi

if [[ ! -f "cdk/package.json" ]]; then
  echo "version-alignment: FAIL (missing cdk/package.json)"
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

if [[ -z "${cdk_version}" ]]; then
  echo "version-alignment: FAIL (cdk/package.json missing version)"
  exit 1
fi

if [[ "${cdk_version}" != "${expected_version}" ]]; then
  echo "version-alignment: FAIL (cdk/package.json ${cdk_version} != ${expected_version})"
  exit 1
fi

if [[ -f "cdk/package-lock.json" ]]; then
  lock_version="$(
    python3 - <<'PY'
import json
from pathlib import Path

data = json.loads(Path("cdk/package-lock.json").read_text(encoding="utf-8"))
print(data.get("version", ""))
PY
  )"

  pkg_lock_version="$(
    python3 - <<'PY'
import json
from pathlib import Path

data = json.loads(Path("cdk/package-lock.json").read_text(encoding="utf-8"))
packages = data.get("packages", {})
root = packages.get("", {}) if isinstance(packages, dict) else {}
print(root.get("version", ""))
PY
  )"

  if [[ "${lock_version}" != "${expected_version}" ]]; then
    echo "version-alignment: FAIL (cdk/package-lock.json ${lock_version} != ${expected_version})"
    exit 1
  fi

  if [[ "${pkg_lock_version}" != "${expected_version}" ]]; then
    echo "version-alignment: FAIL (cdk/package-lock.json packages[''].version ${pkg_lock_version} != ${expected_version})"
    exit 1
  fi
fi

if [[ ! -f "py/pyproject.toml" ]]; then
  echo "version-alignment: FAIL (missing py/pyproject.toml)"
  exit 1
fi

py_version="$(
  python3 - <<'PY'
from pathlib import Path

import tomllib

data = tomllib.loads(Path("py/pyproject.toml").read_text(encoding="utf-8"))
project = data.get("project", {})
print(project.get("version", ""))
PY
)"

if [[ -z "${py_version}" ]]; then
  echo "version-alignment: FAIL (py/pyproject.toml missing project.version)"
  exit 1
fi

if [[ "${py_version}" != "${expected_version}" ]]; then
  echo "version-alignment: FAIL (py/pyproject.toml ${py_version} != ${expected_version})"
  exit 1
fi

python3 - "${expected_version}" <<'PY'
import json
import re
import sys
from pathlib import Path

expected = sys.argv[1]
errors: list[str] = []

base_extra_files = [
    {"type": "generic", "path": "VERSION"},
    {"type": "json", "path": "ts/package.json", "jsonpath": "$.version"},
    {"type": "json", "path": "ts/package-lock.json", "jsonpath": "$.version"},
    {"type": "json", "path": "ts/package-lock.json", "jsonpath": "$.packages[''].version"},
    {"type": "json", "path": "cdk/package.json", "jsonpath": "$.version"},
    {"type": "json", "path": "cdk/package-lock.json", "jsonpath": "$.version"},
    {"type": "json", "path": "cdk/package-lock.json", "jsonpath": "$.packages[''].version"},
    {"type": "json", "path": "cdk/.jsii", "jsonpath": "$.version"},
    {"type": "toml", "path": "py/pyproject.toml", "jsonpath": "$.project.version"},
]

def load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - shell gate reports every parse failure uniformly
        errors.append(f"{path}: failed to parse JSON: {exc}")
        return {}

expected_is_rc = re.match(r"^[0-9]+\.[0-9]+\.[0-9]+-rc(\.[0-9]+)?$", expected) is not None
stable_version_pattern = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")

stable_manifest_path = Path(".release-please-manifest.json")
stable_manifest = load_json(stable_manifest_path)
stable_observed = stable_manifest.get(".") if isinstance(stable_manifest, dict) else None
if expected_is_rc:
    if not isinstance(stable_observed, str) or stable_version_pattern.match(stable_observed) is None:
        errors.append(
            f"{stable_manifest_path}: . version {stable_observed!r} must remain a stable X.Y.Z version "
            f"when VERSION is prerelease {expected!r}"
        )
else:
    if stable_observed != expected:
        errors.append(f"{stable_manifest_path}: . version {stable_observed!r} != {expected!r}")

premain_manifest_path = Path(".release-please-manifest.premain.json")
premain_manifest = load_json(premain_manifest_path)
premain_observed = premain_manifest.get(".") if isinstance(premain_manifest, dict) else None
if premain_observed != expected:
    errors.append(f"{premain_manifest_path}: . version {premain_observed!r} != {expected!r}")

jsii = load_json(Path("cdk/.jsii"))
if jsii.get("version") != expected:
    errors.append(f"cdk/.jsii version {jsii.get('version')!r} != {expected!r}")

example_extra_files: list[dict[str, str]] = []
for lock_path in sorted(Path("examples/cdk").glob("*/package-lock.json")):
    data = load_json(lock_path)
    packages = data.get("packages", {}) if isinstance(data, dict) else {}
    cdk_package = packages.get("../../../cdk", {}) if isinstance(packages, dict) else {}
    if not isinstance(cdk_package, dict):
        continue
    if "version" not in cdk_package:
        continue
    observed = cdk_package.get("version")
    if observed != expected:
        errors.append(f"{lock_path} packages['../../../cdk'].version {observed!r} != {expected!r}")
    example_extra_files.append(
        {"type": "json", "path": str(lock_path), "jsonpath": "$.packages['../../../cdk'].version"}
    )

canonical_extra_files = base_extra_files + example_extra_files
for config_path in (Path("release-please-config.json"), Path("release-please-config.premain.json")):
    data = load_json(config_path)
    actual = (
        data.get("packages", {}).get(".", {}).get("extra-files", [])
        if isinstance(data, dict)
        else []
    )
    if actual != canonical_extra_files:
        actual_paths = [item.get("path") for item in actual if isinstance(item, dict)]
        expected_paths = [item["path"] for item in canonical_extra_files]
        missing = [path for path in expected_paths if path not in actual_paths]
        extra = [path for path in actual_paths if path not in expected_paths]
        errors.append(
            f"{config_path}: extra-files do not match verify-version-alignment source "
            f"(missing={missing}, extra={extra})"
        )

if errors:
    print("version-alignment: FAIL (release-please coverage)", file=sys.stderr)
    for err in errors:
        print(f"- {err}", file=sys.stderr)
    sys.exit(1)
PY

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  expected_tag="v${expected_version}"
  mapfile -t vtags < <(git tag --points-at HEAD | grep -E '^v' || true)
  for vtag in "${vtags[@]}"; do
    if [[ "${vtag}" != "${expected_tag}" ]]; then
      echo "version-alignment: FAIL (tag ${vtag} != ${expected_tag})"
      exit 1
    fi
  done
fi

echo "version-alignment: PASS (${expected_version})"
