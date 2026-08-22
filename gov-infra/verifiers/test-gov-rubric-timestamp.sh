#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

if ! command -v git >/dev/null 2>&1; then
  echo "BLOCKED: missing required tool for provenance regression test: git" >&2
  exit 2
fi

# Source only the report provenance and schema helpers from the production
# verifier. Direct execution refuses helper-only mode, so this is not a rubric
# bypass.
GOV_RUBRIC_PROVENANCE_HELPER_ONLY=1 source "${SCRIPT_DIR}/gov-verify-rubric.sh"

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

assert_timestamp_shape() {
  local value="$1"
  [[ "${value}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || fail "timestamp is not UTC seconds precision: ${value}"
}

assert_grep_absent() {
  local pattern="$1"
  local file="$2"
  local message="$3"
  local status=0

  grep -Eq -- "${pattern}" "${file}" || status=$?
  if [[ "${status}" -ne 1 ]]; then
    fail "${message}: expected grep exit 1, got ${status}"
  fi
}

ORIGINAL_REPO_ROOT="${REPO_ROOT}"
tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

initialize_report_provenance
first_timestamp="${REPORT_TIMESTAMP}"
first_git_head="${REPORT_GIT_HEAD}"
assert_timestamp_shape "${first_timestamp}"

in_repo_probe_head="${tmpdir}/in-repo-git-head.txt"
in_repo_probe_status=0
if in_repo_probe_output="$({
  intended_root_status=0
  require_intended_git_worktree_or_blocked || intended_root_status=$?
  if [[ "${intended_root_status}" -ne 0 ]]; then
    exit "${intended_root_status}"
  fi
  git -C "${ORIGINAL_REPO_ROOT}" rev-parse --verify HEAD >"${in_repo_probe_head}"
} 2>&1)"; then
  in_repo_probe_status=0
else
  in_repo_probe_status=$?
fi
in_repo_probe_raw_fatal_lines="$(printf '%s\n' "${in_repo_probe_output}" | grep -Ec 'fatal:' || true)"
assert_eq "0" "${in_repo_probe_raw_fatal_lines}" "in-repo git_head probe leaked raw Git diagnostics"

case "${in_repo_probe_status}" in
  0)
    expected_git_head="$(cat "${in_repo_probe_head}")"
    assert_eq "${expected_git_head}" "${first_git_head}" "in-repo git_head"
    in_repo_git_head_assertion="PASS"
    in_repo_git_head_assertion_skips=0
    ;;
  2)
    in_repo_git_head_assertion="SKIP"
    in_repo_git_head_assertion_skips=1
    ;;
  *)
    fail "in-repo git_head probe failed with exit ${in_repo_probe_status}"
    ;;
esac

# A report timestamp is run provenance. It must be regenerated rather than
# inherited from the environment or a previous report.
GOV_REPORT_TIMESTAMP="1999-01-01T00:00:00Z"
sleep 1
initialize_report_provenance
second_timestamp="${REPORT_TIMESTAMP}"
assert_timestamp_shape "${second_timestamp}"
[[ "${second_timestamp}" != "${first_timestamp}" ]] || fail "two runs reused the same timestamp"
[[ "${second_timestamp}" != "${GOV_REPORT_TIMESTAMP}" ]] || fail "GOV_REPORT_TIMESTAMP overrode run provenance"
unset GOV_REPORT_TIMESTAMP

# N5: even with a valid 40-hex HEAD in an enclosing repository, a copied
# verifier must omit git_head unless its own REPO_ROOT is the resolved top level.
enclosing_root="${tmpdir}/enclosing"
mkdir -p "${enclosing_root}/scratch-copy"
git -C "${enclosing_root}" init -q -b main
blob="$(printf 'fixture\n' | git -C "${enclosing_root}" hash-object -w --stdin)"
tree="$(printf '100644 blob %s\tfixture\n' "${blob}" | git -C "${enclosing_root}" mktree)"
commit="$(printf 'fixture\n' | git -C "${enclosing_root}" -c user.name='Gov Infra Test' -c user.email='gov-infra@example.invalid' commit-tree "${tree}")"
git -C "${enclosing_root}" update-ref refs/heads/main "${commit}"

REPO_ROOT="${enclosing_root}/scratch-copy"
initialize_report_provenance
assert_eq "" "${REPORT_GIT_HEAD}" "enclosing non-root worktree git_head omission"
assert_eq "" "${REPORT_GIT_HEAD_JSON}" "enclosing non-root worktree JSON omission"

REPO_ROOT="${tmpdir}/plain-scratch"
mkdir -p "${REPO_ROOT}"
initialize_report_provenance
assert_eq "" "${REPORT_GIT_HEAD}" "non-git git_head omission"
assert_eq "" "${REPORT_GIT_HEAD_JSON}" "non-git JSON omission"

non_git_evidence="${tmpdir}/non-git-check.log"
guard_status=0
require_intended_git_worktree_or_blocked >"${non_git_evidence}" 2>&1 || guard_status=$?
assert_eq "2" "${guard_status}" "non-git intended-worktree guard status"
grep -Fq 'BLOCKED: repository root is not the intended Git worktree root' "${non_git_evidence}" \
  || fail "non-git intended-worktree guard did not explain the BLOCKED result"
assert_grep_absent 'fatal:' "${non_git_evidence}" "non-git intended-worktree guard leaked raw Git diagnostics"
non_git_guard_raw_fatal_lines="$(grep -Ec 'fatal:' "${non_git_evidence}" || true)"
all_probe_raw_fatal_lines="$((in_repo_probe_raw_fatal_lines + non_git_guard_raw_fatal_lines))"
assert_eq "0" "${all_probe_raw_fatal_lines}" "captured probe output contained raw Git diagnostics"
REPO_ROOT="${ORIGINAL_REPO_ROOT}"

grep -Fq 'REPORT_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"' "${SCRIPT_DIR}/gov-verify-rubric.sh" \
  || fail "production verifier does not create a fresh run timestamp"
grep -Fq '${REPORT_GIT_HEAD_JSON}  "pack": {' "${SCRIPT_DIR}/gov-verify-rubric.sh" \
  || fail "production report writer does not emit optional git_head provenance"
assert_grep_absent \
  'read_existing_report_timestamp|select_report_timestamp_value' \
  "${SCRIPT_DIR}/gov-verify-rubric.sh" \
  "production verifier still reuses prior timestamp provenance"

echo "gov-rubric provenance regression: PASS"
echo "first_timestamp=${first_timestamp}"
echo "second_timestamp=${second_timestamp}"
echo "git_head=${first_git_head}"
echo "in_repo_git_head_assertion=${in_repo_git_head_assertion}"
echo "in_repo_git_head_assertion_skips=${in_repo_git_head_assertion_skips}"
echo "enclosing_non_root_git_head=omitted"
echo "non_git_git_head=omitted"
echo "non_git_guard_status=${guard_status}"
echo "all_probe_raw_fatal_lines=${all_probe_raw_fatal_lines}"
