#!/usr/bin/env bash
# Purpose: prove AppTheory root and CDK Go modules resolve at exact immutable release tags.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=go-module-release-contract.sh
source "${repo_root}/scripts/go-module-release-contract.sh"
cd "${repo_root}"

verify_remote_tag_target() {
  local remote="$1"
  local tag="$2"
  local source_commit="$3"
  local observed

  observed="$(go_release_remote_tag_commit "${remote}" "${tag}")" || {
    echo "go-module-probe: FAIL (${tag} is absent from ${remote})" >&2
    return 1
  }
  if [[ "${observed}" != "${source_commit}" ]]; then
    echo \
      "go-module-probe: FAIL (${tag} targets ${observed}; expected ${source_commit})" \
      >&2
    return 1
  fi
}

probe_one_module() {
  local module="$1"
  local tag="$2"
  local expected_ref="$3"
  local source_commit="$4"
  local probe_root="$5"
  local attempts="${GO_MODULE_PROBE_ATTEMPTS:-5}"
  local delay="${GO_MODULE_PROBE_DELAY_SECONDS:-2}"
  local attempt
  local output_file
  local error_file

  for (( attempt = 1; attempt <= attempts; attempt++ )); do
    output_file="${probe_root}/probe-${attempt}.json"
    error_file="${probe_root}/probe-${attempt}.err"
    mkdir -p "${probe_root}/mod-${attempt}" "${probe_root}/cache-${attempt}"

    if GIT_TERMINAL_PROMPT=0 \
      GOMODCACHE="${probe_root}/mod-${attempt}" \
      GOCACHE="${probe_root}/cache-${attempt}" \
      GOPROXY=direct \
      GONOSUMDB="${GO_MODULE_NOSUMDB:-github.com/theory-cloud/apptheory*}" \
      GOTOOLCHAIN="${GO_MODULE_GOTOOLCHAIN:-local}" \
      go mod download -json "${module}@${tag}" \
      >"${output_file}" 2>"${error_file}" &&
      python3 - \
        "${output_file}" \
        "${module}" \
        "${tag}" \
        "${expected_ref}" \
        "${source_commit}" <<'PY'
import json
import sys
from pathlib import Path

payload_path, expected_path, expected_version, expected_ref, expected_commit = sys.argv[1:]
data = json.loads(Path(payload_path).read_text(encoding="utf-8"))

if data.get("Error"):
    raise SystemExit(f"resolver returned Error={data['Error']!r}")
if data.get("Path") != expected_path:
    raise SystemExit(f"Path={data.get('Path')!r} != {expected_path!r}")
if data.get("Version") != expected_version:
    raise SystemExit(f"Version={data.get('Version')!r} != {expected_version!r}")

origin = data.get("Origin")
if not isinstance(origin, dict):
    raise SystemExit("resolver did not return Origin")
if origin.get("Hash") != expected_commit:
    raise SystemExit(f"Origin.Hash={origin.get('Hash')!r} != {expected_commit!r}")
if origin.get("Ref") != expected_ref:
    raise SystemExit(f"Origin.Ref={origin.get('Ref')!r} != {expected_ref!r}")

go_mod = data.get("GoMod")
if not isinstance(go_mod, str) or not Path(go_mod).is_file():
    raise SystemExit("resolver did not materialize GoMod")
module_line = next(
    (
        line.split(maxsplit=1)[1]
        for line in Path(go_mod).read_text(encoding="utf-8").splitlines()
        if line.startswith("module ")
    ),
    "",
)
if module_line != expected_path:
    raise SystemExit(f"downloaded module directive={module_line!r} != {expected_path!r}")
PY
    then
      echo \
        "go-module-probe: PASS (${module}@${tag} ref=${expected_ref} source=${source_commit})"
      return 0
    fi

    if (( attempt < attempts )); then
      sleep "${delay}"
    fi
  done

  echo \
    "go-module-probe: FAIL (${module}@${tag} did not resolve exactly after ${attempts} attempts)" \
    >&2
  if [[ -s "${error_file}" ]]; then
    sed -n '1,40p' "${error_file}" >&2
  fi
  if [[ -s "${output_file}" ]]; then
    sed -n '1,80p' "${output_file}" >&2
  fi
  return 1
}

verify_module_set() {
  local remote="$1"
  local tag="$2"
  local source_ref="$3"
  local temporary

  if ! command -v go >/dev/null 2>&1; then
    echo "go-module-probe: FAIL (go not found)" >&2
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "go-module-probe: FAIL (python3 not found)" >&2
    return 1
  fi

  go_release_validate_source_contract "${tag}" "${source_ref}" || return 1
  verify_remote_tag_target \
    "${remote}" \
    "${GO_RELEASE_ROOT_TAG}" \
    "${GO_RELEASE_SOURCE_COMMIT}" || return 1
  verify_remote_tag_target \
    "${remote}" \
    "${GO_RELEASE_CDK_TAG}" \
    "${GO_RELEASE_SOURCE_COMMIT}" || return 1

  temporary="$(mktemp -d)"
  if ! probe_one_module \
    "${GO_RELEASE_ROOT_MODULE}" \
    "${GO_RELEASE_ROOT_TAG}" \
    "refs/tags/${GO_RELEASE_ROOT_TAG}" \
    "${GO_RELEASE_SOURCE_COMMIT}" \
    "${temporary}/root"
  then
    chmod -R u+w "${temporary}" 2>/dev/null || true
    rm -rf "${temporary}"
    return 1
  fi
  if ! probe_one_module \
    "${GO_RELEASE_CDK_MODULE}" \
    "${GO_RELEASE_ROOT_TAG}" \
    "refs/tags/${GO_RELEASE_CDK_TAG}" \
    "${GO_RELEASE_SOURCE_COMMIT}" \
    "${temporary}/cdk"
  then
    chmod -R u+w "${temporary}" 2>/dev/null || true
    rm -rf "${temporary}"
    return 1
  fi
  chmod -R u+w "${temporary}" 2>/dev/null || true
  rm -rf "${temporary}"

  echo \
    "go-module-probe: PASS (root=${GO_RELEASE_ROOT_MODULE}@${GO_RELEASE_ROOT_TAG} cdk=${GO_RELEASE_CDK_MODULE}@${GO_RELEASE_ROOT_TAG})"
}

run_self_test() {
  local temporary
  local remote
  local work
  local source_commit
  local other_commit
  local instead_of
  local output

  temporary="$(mktemp -d)"
  remote="${temporary}/remote.git"
  work="${temporary}/work"

  git init -q --bare "${remote}"
  git init -q "${work}"
  if ! (
    cd "${work}"
    git checkout -q -b main
    printf '%s\n' "2.0.0-rc" >VERSION
    printf '%s\n' \
      "module github.com/theory-cloud/apptheory/v2" \
      "" \
      "go 1.23" >go.mod
    mkdir -p cdk-go/apptheorycdk
    printf '%s\n' \
      "module github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v2" \
      "" \
      "go 1.23" >cdk-go/apptheorycdk/go.mod
    printf '%s\n' "package apptheory" >apptheory.go
    printf '%s\n' "package apptheorycdk" >cdk-go/apptheorycdk/apptheorycdk.go
    git add VERSION go.mod apptheory.go cdk-go/apptheorycdk
    git \
      -c user.name="AppTheory Go Probe Self Test" \
      -c user.email="apptheory-go-probe-self-test@example.invalid" \
      commit -q -m "chore: seed v2 release"
    source_commit="$(git rev-parse HEAD)"

    printf '%s\n' "other" >other.txt
    git add other.txt
    git \
      -c user.name="AppTheory Go Probe Self Test" \
      -c user.email="apptheory-go-probe-self-test@example.invalid" \
      commit -q -m "chore: create conflicting target"
    other_commit="$(git rev-parse HEAD)"

    git remote add origin "${remote}"
    git push -q origin HEAD:refs/heads/main
    git --git-dir="${remote}" update-ref refs/tags/v2.0.0-rc "${source_commit}"
    git --git-dir="${remote}" update-ref \
      refs/tags/cdk-go/apptheorycdk/v2.0.0-rc \
      "${source_commit}"

    instead_of="file://${remote}"
    GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0="url.${instead_of}.insteadOf" \
      GIT_CONFIG_VALUE_0="https://github.com/theory-cloud/apptheory" \
      GO_MODULE_PROBE_ATTEMPTS=1 \
      verify_module_set origin "v2.0.0-rc" "${source_commit}" >/dev/null
    echo "go-module-probe self-test: PASS exact root and nested resolution"

    git --git-dir="${remote}" update-ref \
      refs/tags/cdk-go/apptheorycdk/v2.0.0-rc \
      "${other_commit}"
    if output="$(
      GIT_CONFIG_COUNT=1 \
        GIT_CONFIG_KEY_0="url.${instead_of}.insteadOf" \
        GIT_CONFIG_VALUE_0="https://github.com/theory-cloud/apptheory" \
        GO_MODULE_PROBE_ATTEMPTS=1 \
        verify_module_set origin "v2.0.0-rc" "${source_commit}" 2>&1
    )"; then
      echo "go-module-probe self-test: FAIL (conflicting nested target was accepted)" >&2
      exit 1
    fi
    grep -Fq \
      "cdk-go/apptheorycdk/v2.0.0-rc targets ${other_commit}; expected ${source_commit}" \
      <<<"${output}"
    echo "go-module-probe self-test: PASS conflicting target fails closed"
  ); then
    chmod -R u+w "${temporary}" 2>/dev/null || true
    rm -rf "${temporary}"
    return 1
  fi

  chmod -R u+w "${temporary}" 2>/dev/null || true
  rm -rf "${temporary}"
  echo "go-module-probe self-test: PASS"
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
  exit 0
fi

tag="${1:-}"
source_ref="${2:-}"
if [[ -z "${tag}" || -z "${source_ref}" || $# -ne 2 ]]; then
  echo "go-module-probe: FAIL (usage: $0 <vX.Y.Z[-rc[.N]]> <source-commit>)" >&2
  exit 1
fi

verify_module_set "${GIT_REMOTE:-origin}" "${tag}" "${source_ref}"
