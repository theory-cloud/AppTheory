#!/usr/bin/env bash
# Shared CDK runtime dependency installation contract.
# Source this file from a script that has changed to the repository root.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime-deps.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/retry.sh"

APPTHEORY_CDK_RUNTIME_DEPS_STAMP="cdk/node_modules/.gov-cdk-runtime-deps.sha256"
# Content manifest for the installed dependency tree, written beside the lockfile
# stamp. The stamp alone only records which lockfile produced the tree; it says
# nothing about the bytes on disk, so a cached tree whose contents were modified
# after install (for example a rewritten jsii file) would be reused silently.
APPTHEORY_CDK_RUNTIME_DEPS_MANIFEST="cdk/node_modules/.gov-cdk-runtime-deps.manifest"
APPTHEORY_CDK_RUNTIME_DEPS_STAMP_NAME=".gov-cdk-runtime-deps.sha256"
APPTHEORY_CDK_RUNTIME_DEPS_MANIFEST_NAME=".gov-cdk-runtime-deps.manifest"

cdk_runtime_deps_complete() {
  [[ -f "cdk/node_modules/constructs/package.json" ]] &&
    [[ -f "cdk/node_modules/aws-cdk-lib/package.json" ]]
}

# cdk_runtime_deps_manifest_files lists the dependency tree files that take part
# in the content manifest. The stamp and the manifest itself are excluded so the
# digest is stable across installs.
cdk_runtime_deps_manifest_files() {
  find "${1:-cdk/node_modules}" -type f \
    ! -name "${APPTHEORY_CDK_RUNTIME_DEPS_STAMP_NAME}" \
    ! -name "${APPTHEORY_CDK_RUNTIME_DEPS_MANIFEST_NAME}" \
    -print0 2>/dev/null
}

# cdk_runtime_deps_manifest prints a deterministic content manifest of the
# installed dependency tree: one "<sha256>  <path>" line per file, ordered by
# path. A single bulk hasher pass keeps this affordable for a real node_modules
# with tens of thousands of files.
cdk_runtime_deps_manifest() {
  local hasher=""
  local hasher_args=()

  if command -v sha256sum >/dev/null 2>&1; then
    hasher="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    hasher="shasum"
    hasher_args=(-a 256)
  else
    echo "BLOCKED: sha256 tool missing (need sha256sum or shasum)" >&2
    return 2
  fi

  if [[ -z "$(cdk_runtime_deps_manifest_files "${1:-cdk/node_modules}" | head -c 1)" ]]; then
    return 0
  fi

  cdk_runtime_deps_manifest_files "${1:-cdk/node_modules}" |
    LC_ALL=C sort -z |
    xargs -0 "${hasher}" "${hasher_args[@]}"
}

ensure_cdk_runtime_deps_installed() {
  require_cmd_or_blocked node || return $?
  require_cmd_or_blocked npm || return $?

  if [[ ! -d "cdk" ]]; then
    echo "FAIL: expected CDK project missing: cdk/" >&2
    return 1
  fi
  if [[ ! -f "cdk/package.json" ]]; then
    echo "FAIL: expected CDK package missing: cdk/package.json" >&2
    return 1
  fi
  if [[ ! -f "cdk/package-lock.json" ]]; then
    echo "FAIL: expected CDK lockfile missing: cdk/package-lock.json" >&2
    return 1
  fi

  local lock_hash
  lock_hash="$(file_sha256 "cdk/package-lock.json")" || return $?

  local stamp="${APPTHEORY_CDK_RUNTIME_DEPS_STAMP}"
  local manifest="${APPTHEORY_CDK_RUNTIME_DEPS_MANIFEST}"
  if [[ -d "cdk/node_modules" && -f "${stamp}" && -f "${manifest}" ]] &&
    grep -Fxq "${lock_hash}" "${stamp}" 2>/dev/null &&
    cdk_runtime_deps_complete
  then
    local current_manifest=""
    current_manifest="$(cdk_runtime_deps_manifest)" || return $?
    if [[ "${current_manifest}" == "$(cat "${manifest}")" ]]; then
      return 0
    fi
    echo "CDK runtime deps content does not match the manifest recorded for this lockfile; reinstalling instead of reusing the cached tree..." >&2
  fi

  echo "Installing CDK runtime deps into cdk/node_modules..." >&2
  if ! run_with_retry 3 5 "CDK runtime dependency install" -- \
    bash -c 'cd cdk && npm ci --ignore-scripts --no-audit --no-fund >/dev/null'; then
    echo "BLOCKED: failed to install CDK runtime dependencies (check network/toolchain)" >&2
    return 2
  fi
  if ! cdk_runtime_deps_complete; then
    echo "FAIL: CDK dependencies incomplete after npm ci" >&2
    return 1
  fi

  local installed_manifest=""
  installed_manifest="$(cdk_runtime_deps_manifest)" || return $?

  printf '%s\n' "${lock_hash}" >"${stamp}"
  printf '%s\n' "${installed_manifest}" >"${manifest}"
  return 0
}

# cdk_runtime_deps_self_test_body runs entirely inside a scratch CDK project so
# no repository file, registry, or shared cache is touched. A stub npm on PATH
# records invocations instead of installing anything.
cdk_runtime_deps_self_test_body() {
  local tmp_root="$1"
  local npm_log="${tmp_root}/npm-invocations.log"
  local failures=0
  local stub_jsii='module.exports = { jsii: "pinned" };'

  mkdir -p \
    "${tmp_root}/cdk/node_modules/constructs" \
    "${tmp_root}/cdk/node_modules/aws-cdk-lib" \
    "${tmp_root}/cdk/node_modules/jsii/lib" \
    "${tmp_root}/stub-bin"

  printf '{"name":"cdk-content-self-test"}\n' >"${tmp_root}/cdk/package.json"
  printf '{"name":"cdk-content-self-test","lockfileVersion":3}\n' >"${tmp_root}/cdk/package-lock.json"
  printf '{"name":"constructs"}\n' >"${tmp_root}/cdk/node_modules/constructs/package.json"
  printf '{"name":"aws-cdk-lib"}\n' >"${tmp_root}/cdk/node_modules/aws-cdk-lib/package.json"
  printf '%s\n' "${stub_jsii}" >"${tmp_root}/cdk/node_modules/jsii/lib/index.js"

  cat >"${tmp_root}/stub-bin/npm" <<'STUB_NPM'
#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${CDK_SELF_TEST_NPM_COUNT:-}" ]]; then
  printf 'invoked\n' >>"${CDK_SELF_TEST_NPM_COUNT}"
fi
if [[ "${CDK_SELF_TEST_NPM_FAIL:-}" == "1" ]]; then
  echo "stub npm: refusing to install (self-test)" >&2
  exit 1
fi

mkdir -p node_modules/constructs node_modules/aws-cdk-lib node_modules/jsii/lib
printf '{"name":"constructs"}\n' >node_modules/constructs/package.json
printf '{"name":"aws-cdk-lib"}\n' >node_modules/aws-cdk-lib/package.json
printf '%s\n' 'module.exports = { jsii: "pinned" };' >node_modules/jsii/lib/index.js
STUB_NPM
  chmod +x "${tmp_root}/stub-bin/npm"

  cd "${tmp_root}"
  export PATH="${tmp_root}/stub-bin:${PATH}"
  export CDK_SELF_TEST_NPM_COUNT="${npm_log}"
  unset CDK_SELF_TEST_NPM_FAIL

  local lock_hash=""
  lock_hash="$(file_sha256 "cdk/package-lock.json")" || return 1
  printf '%s\n' "${lock_hash}" >"${APPTHEORY_CDK_RUNTIME_DEPS_STAMP}"
  cdk_runtime_deps_manifest >"${APPTHEORY_CDK_RUNTIME_DEPS_MANIFEST}" || return 1

  : >"${npm_log}"
  if ! ensure_cdk_runtime_deps_installed; then
    echo "cdk-runtime-deps: self-test FAIL (an untouched warm cache must be reusable)" >&2
    failures=$((failures + 1))
  fi
  if [[ -s "${npm_log}" ]]; then
    echo "cdk-runtime-deps: self-test FAIL (reusing an untouched warm cache must invoke npm zero times)" >&2
    failures=$((failures + 1))
  fi

  printf '%s\n' 'module.exports = { jsii: "tampered" };' >"cdk/node_modules/jsii/lib/index.js"
  : >"${npm_log}"
  if ! ensure_cdk_runtime_deps_installed; then
    echo "cdk-runtime-deps: self-test FAIL (a tampered cache must recover through the ordinary install path)" >&2
    failures=$((failures + 1))
  fi
  if [[ "$(wc -l <"${npm_log}" | tr -d '[:space:]')" != "1" ]]; then
    echo "cdk-runtime-deps: self-test FAIL (a tampered cache must be detected before reuse and reinstalled exactly once)" >&2
    failures=$((failures + 1))
  fi
  if grep -q "tampered" "cdk/node_modules/jsii/lib/index.js"; then
    echo "cdk-runtime-deps: self-test FAIL (the tampered file must not survive the reinstall)" >&2
    failures=$((failures + 1))
  fi
  if ! diff <(cdk_runtime_deps_manifest) "${APPTHEORY_CDK_RUNTIME_DEPS_MANIFEST}" >/dev/null; then
    echo "cdk-runtime-deps: self-test FAIL (the manifest must be rewritten for the reinstalled tree)" >&2
    failures=$((failures + 1))
  fi

  printf '%s\n' 'module.exports = { jsii: "tampered-again" };' >"cdk/node_modules/jsii/lib/index.js"
  : >"${npm_log}"
  export CDK_SELF_TEST_NPM_FAIL=1
  local exit_code=0
  # The bounded retry backoff and its BLOCKED line are the expected outcome here.
  ensure_cdk_runtime_deps_installed >/dev/null 2>&1 || exit_code=$?
  unset CDK_SELF_TEST_NPM_FAIL
  if [[ "${exit_code}" != "2" ]]; then
    echo "cdk-runtime-deps: self-test FAIL (a tampered cache with no working install path must fail closed, got exit ${exit_code})" >&2
    failures=$((failures + 1))
  fi

  if (( failures > 0 )); then
    echo "cdk-runtime-deps: self-test FAIL (${failures} case(s))" >&2
    return 1
  fi
  return 0
}

cdk_runtime_deps_self_test() {
  local tmp_root=""
  tmp_root="$(mktemp -d)"

  if (cdk_runtime_deps_self_test_body "${tmp_root}"); then
    rm -rf "${tmp_root}"
    echo "cdk-runtime-deps: self-test PASS"
    return 0
  fi

  rm -rf "${tmp_root}"
  echo "cdk-runtime-deps: self-test FAIL" >&2
  return 1
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  case "${1:-}" in
  --self-test)
    cdk_runtime_deps_self_test
    exit $?
    ;;
  *)
    echo "usage: $0 --self-test" >&2
    exit 2
    ;;
  esac
fi
