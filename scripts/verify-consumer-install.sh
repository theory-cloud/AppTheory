#!/usr/bin/env bash
# Purpose: prove the packed AppTheory artifacts work for a consumer project that
# holds nothing from this repository.
#
# `scripts/verify-ts-pack.sh`, `scripts/verify-python-build.sh` and
# `scripts/verify-cdk-ts-pack.sh` prove the artifacts build and unpack. This gate
# proves they *run*. Three modes, one per published artifact kind:
#
#   ts   the packed TypeScript runtime, installed into an empty package, then
#        exercised through one real `handleLambda` call path.
#   py   the built Python distribution, installed into an empty virtual
#        environment, then exercised through one real `handle_lambda` call path.
#   cdk  the packed jsii CDK construct library and the packed TypeScript runtime
#        it deploys, installed into an empty package, then asked to select
#        `NODEJS_26_X` and `PYTHON_3_15`, resolve both bundling images, and
#        synthesize a stack that declares them.
#
# Every mode installs into a directory that carries no AppTheory sources, no
# tsconfig, no workspace and no link back to this checkout, so the install has to
# resolve the real `@theory-cloud/tabletheory-ts` tarball or `tabletheory-py`
# wheel from its checksum-pinned GitHub Release asset exactly as a consumer's
# install does. That resolution is asserted, not assumed: the dependency is the
# runtime's data layer, and a consumer that cannot install it cannot use the
# package at all. The CDK package's own dependency edges are its declared peer
# dependencies, so its consumer also installs the runtime it deploys rather than
# leaving the data layer untested.
#
# Nothing is skipped and nothing fails soft. A missing artifact, a missing
# export, an unexpected status code, an unresolved TableTheory dependency or a
# synthesized template without the declared runtimes exits non-zero. The gate
# runs under each supported runtime line, so its record is the claim a release
# makes about the line it was produced on.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

mode="${1:-}"
case "${mode}" in
  ts | py | cdk) ;;
  *)
    echo "consumer-install: FAIL (usage: scripts/verify-consumer-install.sh <ts|py|cdk>)" >&2
    exit 1
    ;;
esac

if [[ ! -x "scripts/read-version.sh" ]]; then
  echo "consumer-install: FAIL (missing scripts/read-version.sh)" >&2
  exit 1
fi
version="$(./scripts/read-version.sh)"

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "consumer-install: BLOCKED ($1 not found; mode ${mode})" >&2
    exit 2
  fi
}

work_dir="$(mktemp -d)"
cleanup() { rm -rf "${work_dir}"; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Preconditions shared by every mode.
# ---------------------------------------------------------------------------
require_tool python3

if [[ ! -f "scripts/fixtures/consumer-install/ts/consumer.mjs" ]] ||
  [[ ! -f "scripts/fixtures/consumer-install/py/consumer.py" ]] ||
  [[ ! -f "scripts/fixtures/consumer-install/cdk/consumer.cjs" ]]; then
  echo "consumer-install: FAIL (missing a consumer fixture under scripts/fixtures/consumer-install/)" >&2
  exit 1
fi

# The TableTheory pin is the consumer's real dependency edge. Reading the
# expected version out of the pin means the assertion below can never pass by
# agreeing with itself.
tabletheory_ts_url="$(
  python3 - "ts/package.json" <<'PY'
import json
import sys
from pathlib import Path

package = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
print(package.get("dependencies", {}).get("@theory-cloud/tabletheory-ts", ""))
PY
)"
tabletheory_py_url="$(
  python3 - "py/pyproject.toml" <<'PY'
import sys
import tomllib
from pathlib import Path

project = tomllib.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))["project"]
for dependency in project.get("dependencies", []):
    if dependency.startswith("tabletheory-py @ "):
        print(dependency.split(" @ ", 1)[1].strip())
        break
PY
)"

expected_tabletheory_ts="$(
  python3 - "${tabletheory_ts_url}" <<'PY'
import re
import sys
from urllib.parse import urlsplit

url = urlsplit(sys.argv[1])
match = re.search(r"/download/v([^/]+)/", url.path)
if not match:
    raise SystemExit(f"consumer-install: cannot read the TableTheory TS version out of {sys.argv[1]!r}")
if not url.fragment.startswith("sha512-"):
    raise SystemExit("consumer-install: the TableTheory TS pin carries no sha512 fragment")
print(match.group(1))
PY
)"
expected_tabletheory_py="$(
  python3 - "${tabletheory_py_url}" <<'PY'
import re
import sys
from urllib.parse import urlsplit

url = urlsplit(sys.argv[1])
match = re.search(r"/download/v([^/]+)/", url.path)
if not match:
    raise SystemExit(f"consumer-install: cannot read the tabletheory-py version out of {sys.argv[1]!r}")
if not url.fragment.startswith("sha256="):
    raise SystemExit("consumer-install: the tabletheory-py pin carries no sha256 fragment")
print(match.group(1))
PY
)"

assert_tabletheory_pin_is_immutable() {
  local url="$1"
  if [[ "${url}" != https://github.com/theory-cloud/TableTheory/releases/download/* ]]; then
    echo "consumer-install: FAIL (the TableTheory pin is not an immutable GitHub Release asset: ${url})" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Shared artifact production: pack the TypeScript runtime into a directory.
# ---------------------------------------------------------------------------
pack_ts_tarball() {
  local artifacts_dir="$1"
  local expected_tgz="theory-cloud-apptheory-${version}.tgz"
  local package_dir="${work_dir}/package-ts"

  require_tool node
  require_tool npm
  assert_tabletheory_pin_is_immutable "${tabletheory_ts_url}"

  # Progress goes to stderr: this function returns the tarball path on stdout.
  echo "consumer-install: packing ${expected_tgz} from a clean copy of ts/" >&2
  cp -a ts "${package_dir}"
  rm -rf "${package_dir}/node_modules" "${package_dir}/dist"
  (cd "${package_dir}" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)
  (cd "${package_dir}" && npm run build >/dev/null)
  mkdir -p "${artifacts_dir}"
  (cd "${package_dir}" && npm pack --silent --pack-destination "${artifacts_dir}" >/dev/null)

  if [[ ! -f "${artifacts_dir}/${expected_tgz}" ]]; then
    echo "consumer-install: FAIL (npm pack did not produce ${expected_tgz})" >&2
    exit 1
  fi
  echo "${artifacts_dir}/${expected_tgz}"
}

# Assert the resolved dependency is the pinned immutable release asset, read out
# of the consumer's own lockfile so the assertion cannot agree with itself.
assert_ts_consumer_resolved_tabletheory() {
  local consumer_dir="$1"
  local tabletheory_package="${consumer_dir}/node_modules/@theory-cloud/tabletheory-ts/package.json"
  if [[ ! -f "${tabletheory_package}" ]]; then
    echo "consumer-install: FAIL (the install did not resolve @theory-cloud/tabletheory-ts)" >&2
    exit 1
  fi
  local installed_tabletheory
  installed_tabletheory="$(node -p "require('${tabletheory_package}').version")"
  if [[ "${installed_tabletheory}" != "${expected_tabletheory_ts}" ]]; then
    echo "consumer-install: FAIL (resolved @theory-cloud/tabletheory-ts ${installed_tabletheory}, expected ${expected_tabletheory_ts})" >&2
    exit 1
  fi
  local resolved_tabletheory
  resolved_tabletheory="$(
    python3 - "${consumer_dir}/package-lock.json" <<'PY'
import json
import sys
from pathlib import Path

lock = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
entry = lock.get("packages", {}).get("node_modules/@theory-cloud/tabletheory-ts", {})
print(entry.get("resolved", ""))
PY
  )"
  assert_tabletheory_pin_is_immutable "${resolved_tabletheory}"
  echo "${installed_tabletheory}"
}

# ---------------------------------------------------------------------------
# Mode: ts — packed TypeScript runtime into an empty consumer package.
# ---------------------------------------------------------------------------
install_ts() {
  local artifacts_dir="${work_dir}/artifacts-ts"
  local consumer_dir="${work_dir}/consumer-ts"
  local tarball
  tarball="$(pack_ts_tarball "${artifacts_dir}")"

  # An empty consumer package: no AppTheory sources, no tsconfig, no workspace.
  mkdir -p "${consumer_dir}"
  cat >"${consumer_dir}/package.json" <<'JSON'
{
  "name": "apptheory-consumer-install",
  "private": true,
  "version": "0.0.0",
  "type": "module"
}
JSON

  echo "consumer-install(ts): installing $(basename "${tarball}") into an empty package"
  (cd "${consumer_dir}" &&
    npm install --ignore-scripts --no-audit --no-fund --save-exact "${tarball}" >/dev/null)

  local installed_package="${consumer_dir}/node_modules/@theory-cloud/apptheory/package.json"
  if [[ ! -f "${installed_package}" ]]; then
    echo "consumer-install(ts): FAIL (the tarball did not install @theory-cloud/apptheory)" >&2
    exit 1
  fi
  local installed_version
  installed_version="$(node -p "require('${installed_package}').version")"
  if [[ "${installed_version}" != "${version}" ]]; then
    echo "consumer-install(ts): FAIL (installed ${installed_version}, expected ${version})" >&2
    exit 1
  fi

  local installed_tabletheory
  installed_tabletheory="$(assert_ts_consumer_resolved_tabletheory "${consumer_dir}")"

  cp scripts/fixtures/consumer-install/ts/consumer.mjs "${consumer_dir}/consumer.mjs"

  echo "consumer-install(ts): node $(node --version), npm $(npm --version)"
  echo "consumer-install(ts): artifact $(basename "${tarball}"), tabletheory-ts ${installed_tabletheory}"
  (cd "${consumer_dir}" && node consumer.mjs)

  echo "consumer-install(ts): PASS ($(basename "${tarball}") on node $(node --version))"
}

# ---------------------------------------------------------------------------
# Mode: py — built Python distribution into an empty virtual environment.
# ---------------------------------------------------------------------------
install_py() {
  assert_tabletheory_pin_is_immutable "${tabletheory_py_url}"

  if [[ ! -f "py/requirements-build.txt" ]]; then
    echo "consumer-install(py): FAIL (missing py/requirements-build.txt)" >&2
    exit 1
  fi

  local build_venv="${work_dir}/build-venv"
  local artifacts_dir="${work_dir}/artifacts-py"
  local consumer_dir="${work_dir}/consumer-py"
  mkdir -p "${artifacts_dir}"

  echo "consumer-install(py): building the wheel from a clean copy of py/"
  python3 -m venv "${build_venv}"
  "${build_venv}/bin/python" -m pip install --quiet --upgrade pip >/dev/null
  "${build_venv}/bin/python" -m pip install --quiet --requirement py/requirements-build.txt >/dev/null
  cp -a py "${work_dir}/py"
  rm -rf "${work_dir}/py/.venv"
  "${build_venv}/bin/python" -m build --no-isolation --wheel "${work_dir}/py" --outdir "${artifacts_dir}" >/dev/null

  local wheel
  wheel="$(find "${artifacts_dir}" -maxdepth 1 -name 'apptheory-*.whl' | head -n 1)"
  if [[ -z "${wheel}" ]]; then
    echo "consumer-install(py): FAIL (the build produced no apptheory wheel)" >&2
    exit 1
  fi

  # An empty consumer environment: no AppTheory sources, no requirements file.
  python3 -m venv "${consumer_dir}"
  "${consumer_dir}/bin/python" -m pip install --quiet --upgrade pip >/dev/null
  echo "consumer-install(py): installing $(basename "${wheel}") into an empty environment"
  "${consumer_dir}/bin/python" -m pip install --quiet "${wheel}" >/dev/null

  local distribution_version
  distribution_version="$(
    "${consumer_dir}/bin/python" - "${version}" <<'PY'
import sys
from importlib.metadata import version

expected = sys.argv[1].replace("-rc.", "rc").replace("-rc", "rc0")
installed = version("apptheory")
if installed != expected:
    raise SystemExit(f"consumer-install(py): FAIL (installed apptheory {installed}, expected {expected})")
print(installed)
PY
  )"

  local installed_tabletheory
  installed_tabletheory="$("${consumer_dir}/bin/python" -c "from importlib.metadata import version; print(version('tabletheory-py'))")"
  if [[ "${installed_tabletheory}" != "${expected_tabletheory_py}" ]]; then
    echo "consumer-install(py): FAIL (resolved tabletheory-py ${installed_tabletheory}, expected ${expected_tabletheory_py})" >&2
    exit 1
  fi
  local resolved_tabletheory
  resolved_tabletheory="$(
    "${consumer_dir}/bin/python" <<'PY'
import json
from importlib.metadata import distribution

direct_url = distribution("tabletheory-py").read_text("direct_url.json")
if not direct_url:
    raise SystemExit("consumer-install(py): FAIL (tabletheory-py records no direct_url.json; the pin did not resolve)")
print(json.loads(direct_url).get("url", ""))
PY
  )"
  assert_tabletheory_pin_is_immutable "${resolved_tabletheory}"

  cp scripts/fixtures/consumer-install/py/consumer.py "${consumer_dir}/consumer.py"

  echo "consumer-install(py): python $("${consumer_dir}/bin/python" --version 2>&1), tabletheory-py ${installed_tabletheory}"
  (cd "${consumer_dir}" && "${consumer_dir}/bin/python" consumer.py)

  echo "consumer-install(py): PASS (apptheory ${distribution_version} on $("${consumer_dir}/bin/python" --version 2>&1))"
}

# ---------------------------------------------------------------------------
# Mode: cdk — packed jsii CDK construct library into an empty consumer package,
# selecting the newest supported Lambda runtimes and synthesizing them.
# ---------------------------------------------------------------------------
install_cdk() {
  require_tool node
  require_tool npm

  local expected_tgz="theory-cloud-apptheory-cdk-${version}.tgz"
  local package_dir="${work_dir}/package-cdk"
  local artifacts_dir="${work_dir}/artifacts-cdk"
  local consumer_dir="${work_dir}/consumer-cdk"

  local aws_cdk_lib constructs
  aws_cdk_lib="$(node -p "require('./cdk/package.json').peerDependencies['aws-cdk-lib']")"
  constructs="$(node -p "require('./cdk/package.json').devDependencies.constructs")"

  echo "consumer-install(cdk): packing ${expected_tgz} from a clean copy of cdk/"
  cp -a cdk "${package_dir}"
  rm -rf "${package_dir}/node_modules" "${package_dir}/dist"
  (cd "${package_dir}" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)
  (cd "${package_dir}" && npm run build >/dev/null)
  mkdir -p "${artifacts_dir}"
  (cd "${package_dir}" && npm pack --silent --pack-destination "${artifacts_dir}" >/dev/null)

  if [[ ! -f "${artifacts_dir}/${expected_tgz}" ]]; then
    echo "consumer-install(cdk): FAIL (npm pack did not produce ${expected_tgz})" >&2
    exit 1
  fi

  # The construct library deploys the runtime, so its consumer installs the
  # runtime artifact too. That is also what gives this receipt the data-layer
  # dependency edge the CDK package does not declare itself.
  local runtime_tarball
  runtime_tarball="$(pack_ts_tarball "${artifacts_dir}")"

  mkdir -p "${consumer_dir}"
  cat >"${consumer_dir}/package.json" <<'JSON'
{
  "name": "apptheory-cdk-consumer-install",
  "private": true,
  "version": "0.0.0"
}
JSON

  echo "consumer-install(cdk): installing both tarballs with aws-cdk-lib ${aws_cdk_lib} and constructs ${constructs}"
  (cd "${consumer_dir}" &&
    npm install --ignore-scripts --no-audit --no-fund --save-exact \
      "${artifacts_dir}/${expected_tgz}" "${runtime_tarball}" \
      "aws-cdk-lib@${aws_cdk_lib}" "constructs@${constructs}" >/dev/null)

  local installed_package="${consumer_dir}/node_modules/@theory-cloud/apptheory-cdk/package.json"
  if [[ ! -f "${installed_package}" ]]; then
    echo "consumer-install(cdk): FAIL (the tarball did not install @theory-cloud/apptheory-cdk)" >&2
    exit 1
  fi
  local installed_version
  installed_version="$(node -p "require('${installed_package}').version")"
  if [[ "${installed_version}" != "${version}" ]]; then
    echo "consumer-install(cdk): FAIL (installed ${installed_version}, expected ${version})" >&2
    exit 1
  fi

  local installed_tabletheory
  installed_tabletheory="$(assert_ts_consumer_resolved_tabletheory "${consumer_dir}")"

  cp scripts/fixtures/consumer-install/cdk/consumer.cjs "${consumer_dir}/consumer.cjs"
  mkdir -p "${consumer_dir}/cdk.out"

  echo "consumer-install(cdk): node $(node --version), aws-cdk-lib ${aws_cdk_lib}, constructs ${constructs}"
  echo "consumer-install(cdk): artifacts ${expected_tgz} + $(basename "${runtime_tarball}"), tabletheory-ts ${installed_tabletheory}"
  (cd "${consumer_dir}" && node consumer.cjs)

  echo "consumer-install(cdk): PASS (${expected_tgz} on node $(node --version))"
}

case "${mode}" in
  ts) install_ts ;;
  py) install_py ;;
  cdk) install_cdk ;;
esac
