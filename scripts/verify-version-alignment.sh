#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "--self-test" ]]; then
  tmp_dir="$(mktemp -d)"
  tmp_log="$(mktemp)"
  cleanup() {
    rm -rf "${tmp_dir}"
    rm -f "${tmp_log}"
  }
  trap cleanup EXIT

  mkdir -p "${tmp_dir}/scripts" "${tmp_dir}/ts" "${tmp_dir}/cdk" "${tmp_dir}/py" "${tmp_dir}/examples/cdk"
  cp VERSION go.mod .release-please-manifest.json .release-please-manifest.premain.json \
    release-please-config.json release-please-config.premain.json "${tmp_dir}/"
  cp scripts/read-version.sh scripts/verify-version-alignment.sh "${tmp_dir}/scripts/"
  cp ts/package.json ts/package-lock.json "${tmp_dir}/ts/"
  cp cdk/package.json cdk/package-lock.json cdk/.jsii "${tmp_dir}/cdk/"
  cp py/pyproject.toml "${tmp_dir}/py/"
  while IFS= read -r lockfile; do
    mkdir -p "${tmp_dir}/$(dirname "${lockfile}")"
    cp "${lockfile}" "${tmp_dir}/${lockfile}"
  done < <(find examples/cdk -maxdepth 2 -name package-lock.json -print | sort)

  python3 - "${tmp_dir}/cdk/.jsii" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8"))
data["version"] = "0.0.0-self-test"
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY

  if (cd "${tmp_dir}" && bash scripts/verify-version-alignment.sh >"${tmp_log}" 2>&1); then
    echo "version-alignment-self-test: FAIL (deliberate cdk/.jsii skew passed)" >&2
    cat "${tmp_log}" >&2
    exit 1
  fi
  if ! grep -Fq "cdk/.jsii" "${tmp_log}"; then
    echo "version-alignment-self-test: FAIL (skew failure did not mention cdk/.jsii)" >&2
    cat "${tmp_log}" >&2
    exit 1
  fi

  echo "version-alignment-self-test: PASS"
  exit 0
fi

expected_module="github.com/theory-cloud/apptheory"

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

if [[ ! -f "go.mod" ]]; then
  echo "version-alignment: FAIL (missing go.mod)"
  exit 1
fi

observed_module="$(awk '/^module[[:space:]]+/{print $2; exit}' go.mod || true)"
if [[ "${observed_module}" != "${expected_module}" ]]; then
  echo "version-alignment: FAIL (go.mod module '${observed_module}' != '${expected_module}')"
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

for manifest_path in (Path(".release-please-manifest.json"), Path(".release-please-manifest.premain.json")):
    data = load_json(manifest_path)
    observed = data.get(".") if isinstance(data, dict) else None
    if observed != expected:
        errors.append(f"{manifest_path}: . version {observed!r} != {expected!r}")

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
