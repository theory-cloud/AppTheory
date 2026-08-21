#!/usr/bin/env bash
# Shared TypeScript runtime dependency installation contract.
# Source this file from a script that has changed to the repository root.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/blocked.sh"

APPTHEORY_TS_RUNTIME_DEPS_STAMP="ts/node_modules/.gov-ts-runtime-deps.sha256"

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    echo "BLOCKED: sha256 tool missing (need sha256sum or shasum)" >&2
    return 2
  fi
}

file_sha256() {
  local file_path="$1"
  sha256_stdin <"${file_path}"
}

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
