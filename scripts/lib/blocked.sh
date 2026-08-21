#!/usr/bin/env bash
# Shared BLOCKED contract for missing command-line tools.

require_cmd_or_blocked() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    echo "BLOCKED: missing required tool: ${name}" >&2
    return 2
  fi
  return 0
}
