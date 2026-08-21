#!/usr/bin/env bash
# Shared TypeScript runtime dependency installation contract.
# Source this file from a script that has changed to the repository root.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime-deps.sh"

APPTHEORY_TS_RUNTIME_DEPS_STAMP="ts/node_modules/.gov-ts-runtime-deps.sha256"

ensure_ts_runtime_deps_installed() {
  require_cmd_or_blocked node || return $?
  require_cmd_or_blocked npm || return $?

  if [[ ! -d "ts" ]]; then
    echo "FAIL: expected TypeScript project missing: ts/" >&2
    return 1
  fi
  if [[ ! -f "ts/package.json" ]]; then
    echo "FAIL: expected TypeScript package missing: ts/package.json" >&2
    return 1
  fi
  if [[ ! -f "ts/package-lock.json" ]]; then
    echo "FAIL: expected TypeScript lockfile missing: ts/package-lock.json" >&2
    return 1
  fi

  local lock_hash
  lock_hash="$(file_sha256 "ts/package-lock.json")" || return $?

  local stamp="${APPTHEORY_TS_RUNTIME_DEPS_STAMP}"
  if [[ -d "ts/node_modules" && -f "${stamp}" ]] && grep -Fxq "${lock_hash}" "${stamp}" 2>/dev/null; then
    return 0
  fi

  echo "Installing TypeScript runtime deps into ts/node_modules..." >&2
  if ! (cd ts && npm ci --no-audit --no-fund >/dev/null); then
    echo "BLOCKED: failed to install TypeScript runtime dependencies (check network/toolchain)" >&2
    return 2
  fi

  printf '%s\n' "${lock_hash}" >"${stamp}"
  return 0
}
