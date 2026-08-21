#!/usr/bin/env bash
# Shared CDK runtime dependency installation contract.
# Source this file from a script that has changed to the repository root.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime-deps.sh"

APPTHEORY_CDK_RUNTIME_DEPS_STAMP="cdk/node_modules/.gov-cdk-runtime-deps.sha256"

cdk_runtime_deps_complete() {
  [[ -f "cdk/node_modules/constructs/package.json" ]] &&
    [[ -f "cdk/node_modules/aws-cdk-lib/package.json" ]]
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
  if [[ -d "cdk/node_modules" && -f "${stamp}" ]] &&
    grep -Fxq "${lock_hash}" "${stamp}" 2>/dev/null &&
    cdk_runtime_deps_complete
  then
    return 0
  fi

  echo "Installing CDK runtime deps into cdk/node_modules..." >&2
  if ! (cd cdk && npm ci --no-audit --no-fund >/dev/null); then
    echo "BLOCKED: failed to install CDK runtime dependencies (check network/toolchain)" >&2
    return 2
  fi
  if ! cdk_runtime_deps_complete; then
    echo "FAIL: CDK dependencies incomplete after npm ci" >&2
    return 1
  fi

  printf '%s\n' "${lock_hash}" >"${stamp}"
  return 0
}
