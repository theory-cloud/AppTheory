#!/usr/bin/env bash
# Shared bounded-retry helper for network-dependent commands.
#
# Source this file from a script that has changed to the repository root.
#
# Usage:
#   run_with_retry <attempts> <initial-backoff-seconds> <description> -- <command...>
#
# Retries with exponential backoff and returns the last attempt's exit code, so
# callers keep failing closed when every attempt fails. A non-positive or
# unparseable attempt count or backoff is refused with exit 2 rather than
# silently degrading to a single attempt.

run_with_retry() {
  if [[ "$#" -lt 4 ]]; then
    echo "BLOCKED: run_with_retry requires: <attempts> <backoff-seconds> <description> -- <command...>" >&2
    return 2
  fi

  local attempts="$1"
  local backoff="$2"
  local description="$3"
  shift 3

  if [[ "${1:-}" == "--" ]]; then
    shift
  fi

  local -a command=("$@")

  if ! [[ "${attempts}" =~ ^[0-9]+$ ]] || [[ "${attempts}" -lt 1 ]]; then
    echo "BLOCKED: run_with_retry requires a positive attempt count (got '${attempts}')" >&2
    return 2
  fi
  if ! [[ "${backoff}" =~ ^[0-9]+$ ]] || [[ "${backoff}" -lt 1 ]]; then
    echo "BLOCKED: run_with_retry requires a positive backoff in seconds (got '${backoff}')" >&2
    return 2
  fi
  if [[ "${#command[@]}" -eq 0 ]]; then
    echo "BLOCKED: run_with_retry requires a command after --" >&2
    return 2
  fi

  local attempt=1
  local delay="${backoff}"
  local ec=0

  while true; do
    if "${command[@]}"; then
      if (( attempt > 1 )); then
        echo "retry: ${description} succeeded on attempt ${attempt}/${attempts}" >&2
      fi
      return 0
    else
      ec=$?
    fi

    if (( attempt >= attempts )); then
      echo "FAIL: ${description} failed after ${attempts} attempt(s) (exit ${ec})" >&2
      return "${ec}"
    fi

    echo "retry: ${description} failed on attempt ${attempt}/${attempts} (exit ${ec}); retrying in ${delay}s" >&2
    sleep "${delay}"
    delay=$(( delay * 2 ))
    attempt=$(( attempt + 1 ))
  done
}
