#!/usr/bin/env bash
# Shared runtime dependency installation primitives.
# Source this file from a script that has changed to the repository root.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/blocked.sh"

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
