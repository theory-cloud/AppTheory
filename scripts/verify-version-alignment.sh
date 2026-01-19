#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

expected_module="github.com/theory-cloud/apptheory"

if [[ ! -f "VERSION" ]]; then
  echo "version-alignment: FAIL (missing VERSION)"
  exit 1
fi

expected_version="$(tr -d ' \t\r\n' < VERSION)"
if [[ -z "${expected_version}" ]]; then
  echo "version-alignment: FAIL (empty VERSION)"
  exit 1
fi

if [[ ! "${expected_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]]; then
  echo "version-alignment: FAIL (VERSION '${expected_version}' must match X.Y.Z or X.Y.Z-rc.N)"
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

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  vtag="$(git tag --points-at HEAD | grep -E '^v' | head -n 1 || true)"
  if [[ -n "${vtag}" && "${vtag}" != "v${expected_version}" ]]; then
    echo "version-alignment: FAIL (tag ${vtag} != v${expected_version})"
    exit 1
  fi
fi

echo "version-alignment: PASS (${expected_version})"
