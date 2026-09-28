#!/usr/bin/env bash
# Purpose: regression test for the shared bounded-retry helper that guards
# network-dependent installs in the GovTheory verifier and the runtime-dependency
# libraries. Proves that retries are bounded, that backoff is applied, that a
# permanently failing command still fails closed with its own exit code, and that
# malformed parameters are refused instead of silently degrading to one attempt.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

# shellcheck source=../../scripts/lib/retry.sh
source "${REPO_ROOT}/scripts/lib/retry.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local message="$3"

  if [[ "${actual}" != "${expected}" ]]; then
    fail "${message}: expected '${expected}', got '${actual}'"
  fi
}

require_contains() {
  local path="$1"
  local needle="$2"
  local description="$3"

  grep -Fq -- "${needle}" "${path}" || fail "${description}; missing ${needle} in ${path}"
}

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT

attempt_log="${work_dir}/attempts"
: >"${attempt_log}"

count_attempts() {
  wc -c <"${attempt_log}" | tr -d ' '
}

record_attempt() {
  printf 'x' >>"${attempt_log}"
}

# A first-attempt success must not retry, sleep, or duplicate the command.
if ! run_with_retry 3 1 "first-attempt success" -- bash -c 'exit 0'; then
  fail "first-attempt success was reported as a failure"
fi
assert_eq "0" "$(count_attempts)" "first-attempt success must not record an attempt"

# A transient failure must be retried, bounded, and then succeed.
if ! run_with_retry 3 1 "transient failure" -- bash -c 'printf x >> "$1"; [ "$(wc -c < "$1")" -ge 2 ]' _ "${attempt_log}"; then
  fail "transient failure did not succeed within its attempt budget"
fi
assert_eq "2" "$(count_attempts)" "transient failure must be retried exactly once"

# A permanent failure must exhaust the budget, stay bounded, and preserve the
# command's own exit code so callers keep failing closed.
: >"${attempt_log}"
set +e
run_with_retry 3 1 "permanent failure" -- bash -c 'printf x >> "$1"; exit 7' _ "${attempt_log}" >"${work_dir}/permanent.log" 2>&1
permanent_status=$?
set -e
assert_eq "7" "${permanent_status}" "permanent failure must return the command exit code"
assert_eq "3" "$(count_attempts)" "permanent failure must stop after the attempt budget"
grep -Fq "failed after 3 attempt(s) (exit 7)" "${work_dir}/permanent.log" \
  || fail "permanent failure did not report the exhausted attempt budget"

# Backoff must grow between attempts (1s then 2s for a 3-attempt budget).
start_seconds="${SECONDS}"
set +e
run_with_retry 3 1 "backoff timing" -- bash -c 'exit 3' >/dev/null 2>&1
set -e
elapsed_seconds=$((SECONDS - start_seconds))
if (( elapsed_seconds < 3 )); then
  fail "backoff did not delay retries: 3 attempts at 1s backoff took ${elapsed_seconds}s"
fi

# Malformed parameters must be refused, never silently downgraded to one attempt.
for malformed in "0 1" "abc 1" "3 0" "3 abc"; do
  set +e
  # shellcheck disable=SC2086
  run_with_retry ${malformed} "malformed" -- true >"${work_dir}/malformed.log" 2>&1
  malformed_status=$?
  set -e
  assert_eq "2" "${malformed_status}" "malformed parameters '${malformed}' must be refused"
done

set +e
run_with_retry 3 1 "missing command" >"${work_dir}/nocmd.log" 2>&1
nocmd_status=$?
set -e
assert_eq "2" "${nocmd_status}" "a retry without a command must be refused"

# The retried surfaces must still route their network installs through the
# helper: a future edit cannot silently drop the bounded retry.
require_contains "gov-infra/verifiers/gov-verify-rubric.sh" \
  'run_with_retry 3 5 "install pinned ${tool_name} ${version}"' \
  "pinned Go tool installation must use bounded retry"
require_contains "gov-infra/verifiers/gov-verify-rubric.sh" \
  'run_with_retry 3 5 "install pinned pip-audit ${v}"' \
  "pinned pip-audit installation must use bounded retry"
require_contains "gov-infra/verifiers/gov-verify-rubric.sh" \
  'run_with_retry 3 5 "install Python runtime deps"' \
  "Python runtime dependency installation must use bounded retry"
require_contains "gov-infra/verifiers/gov-verify-rubric.sh" \
  'run_with_retry 3 5 "install pinned Coverage.py ${v}"' \
  "pinned Coverage.py installation must use bounded retry"
require_contains "gov-infra/verifiers/gov-verify-rubric.sh" \
  'run_with_retry 3 5 "tidy generated cdk Go module"' \
  "generated cdk module tidy must use bounded retry"
require_contains "scripts/lib/ts-runtime-deps.sh" \
  'run_with_retry 3 5 "TypeScript runtime dependency install"' \
  "TypeScript runtime dependency install must use bounded retry"
require_contains "scripts/lib/cdk-runtime-deps.sh" \
  'run_with_retry 3 5 "CDK runtime dependency install"' \
  "CDK runtime dependency install must use bounded retry"

echo "gov-retry: PASS"
echo "permanent_failure_status=${permanent_status}"
echo "permanent_failure_attempts=3"
echo "malformed_parameter_status=2"
echo "backoff_elapsed_seconds=${elapsed_seconds}"
