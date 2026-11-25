#!/usr/bin/env bash
# Purpose: synthesize the generated CDK Python binding so contract section 11.4
# (the synth refusal and the derived-name artifact) is proved in Python too, and
# not only in TypeScript (r4, SANITY-AT-N3-04).
#
# The repository ships no Python CDK binding harness: `py/` is the runtime SDK,
# the jsii `python` distribution is built on demand by `jsii-pacmak`, and no
# `apptheory_cdk` package is checked in. This script is the minimum harness. It
# builds the wheel from `cdk/`, installs it with the runtime versions the wheel
# itself requires in a throwaway virtual environment, and runs
# `cdk/test-python/naming_bindings_test.py`.
#
# Exit codes: 0 PASS, 1 FAIL, 2 BLOCKED. BLOCKED means this host or job cannot
# run the check at all (a missing tool, or a wheel whose runtime requirements
# cannot be installed). A failure inside `jsii-pacmak` is a FAIL: it builds the
# distribution the gate proves, and it fetches its own Python build toolchain
# while doing so, so an offline host fails there as FAIL rather than BLOCKED
# (ADV-N3-R1).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib/cdk-runtime-deps.sh
source "scripts/lib/cdk-runtime-deps.sh"

for required in node npm python3; do
  if ! command -v "${required}" >/dev/null 2>&1; then
    echo "cdk-python-bindings: BLOCKED (${required} not found)" >&2
    exit 2
  fi
done

if [[ ! -f "cdk/test-python/naming_bindings_test.py" ]]; then
  echo "cdk-python-bindings: FAIL (missing cdk/test-python/naming_bindings_test.py)" >&2
  exit 1
fi

ensure_cdk_runtime_deps_installed || exit $?

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

# jsii writes the assembly the Python target consumes.
(cd cdk && npm run build >/dev/null)

# This step is a FAIL whatever its cause: `jsii-pacmak` builds the Python
# distribution inside this gate, and it fetches its own Python build toolchain
# while doing so, so an offline host fails here too. The gate marks only the
# wheel install below BLOCKED, because that step's failure is always a missing
# or unreachable runtime rather than a defect in what this repository builds.
pacmak_log="${tmp_dir}/jsii-pacmak.log"
if ! (cd cdk && npx jsii-pacmak -t python -o "${tmp_dir}/dist" --force >"${pacmak_log}" 2>&1); then
  cat "${pacmak_log}" >&2
  echo "cdk-python-bindings: FAIL (jsii-pacmak could not build the CDK Python distribution; this window is a FAIL for every cause, including an offline host that cannot fetch pacmak's own Python build toolchain)" >&2
  exit 1
fi

wheel="$(find "${tmp_dir}/dist/python" -maxdepth 1 -name '*.whl' -print -quit)"
if [[ -z "${wheel}" ]]; then
  echo "cdk-python-bindings: FAIL (jsii-pacmak produced no python wheel)" >&2
  exit 1
fi

# The wheel's own metadata pins the runtime the binding needs, so read the pins
# from the wheel instead of restating them here.
requirement_args=()
while IFS= read -r requirement; do
  [[ -n "${requirement}" ]] && requirement_args+=("${requirement}")
done < <(
  python3 - "${wheel}" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    metadata = next(name for name in archive.namelist() if name.endswith("METADATA"))
    for line in archive.read(metadata).decode("utf-8").splitlines():
        if line.startswith("Requires-Dist:"):
            print(line.split(":", 1)[1].strip())
PY
)
if (( ${#requirement_args[@]} == 0 )); then
  echo "cdk-python-bindings: FAIL (the wheel declares no runtime requirements)" >&2
  exit 1
fi

python3 -m venv "${tmp_dir}/venv"
if ! "${tmp_dir}/venv/bin/pip" install --quiet --disable-pip-version-check \
  "${requirement_args[@]}" "${wheel}" >"${tmp_dir}/pip.log" 2>&1; then
  cat "${tmp_dir}/pip.log" >&2
  echo "cdk-python-bindings: BLOCKED (could not install the CDK Python runtime; check network/toolchain)" >&2
  exit 2
fi

"${tmp_dir}/venv/bin/python" cdk/test-python/naming_bindings_test.py

echo "cdk-python-bindings: PASS (jsii python binding synthesizes the refusal and the artifact)"
