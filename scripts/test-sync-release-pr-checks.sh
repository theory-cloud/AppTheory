#!/usr/bin/env bash
# Purpose: exercise the release check lane's decision path without GitHub.
#
# scripts/sync-release-pr-checks.sh is the only thing that attaches the required
# premain/main contexts to a generated release pull request, so its decisions are
# pinned here against a stub `gh`: a green head is reused and marked ready, a red
# head is refused and never re-dispatched, a missing head is dispatched exactly
# once with the pull request number and head SHA, a skipped context is not
# treated as proof, and the sweep reports an unrecoverable head instead of
# failing a scheduled run.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

scratch="$(mktemp -d "${TMPDIR:-/tmp}/apptheory-release-pr-checks.XXXXXX")"
# shellcheck disable=SC2064 # the path is expanded now; the local is gone at EXIT
trap "rm -rf '${scratch}'" EXIT

mkdir -p "${scratch}/bin"
cat >"${scratch}/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
args="$*"
case "${args}" in
  "api repos/o/r/commits/"*"/check-runs"*)
    printf '%s' "${STUB_CHECKS}"
    ;;
  "api repos/o/r/actions/runs?head_sha="*)
    printf '%s' "${STUB_RUNS:-{\"workflow_runs\":[]}}"
    ;;
  "api repos/o/r/pulls/"*)
    printf '%s' "${STUB_PR}"
    ;;
  "pr list"*)
    printf '%s\n' "${STUB_LIST:-}"
    ;;
  "pr view"*)
    printf '{"statusCheckRollup":%s}' "${STUB_ROLLUP:-null}"
    ;;
  "pr ready"*)
    printf 'ready %s\n' "${args}" >>"${STUB_CALLS}"
    printf '%s' "${STUB_PR}"
    ;;
  "workflow run"*)
    printf 'dispatch %s\n' "${args}" >>"${STUB_CALLS}"
    ;;
  *)
    echo "stub: unhandled ${args}" >&2
    exit 1
    ;;
esac
STUB
chmod +x "${scratch}/bin/gh"

head_sha="1111111111111111111111111111111111111111"

pr_payload() {
  local draft="$1"
  printf '{"number":7,"state":"open","draft":%s,"head":{"ref":"release-please--branches--premain","sha":"%s"},"base":{"ref":"premain"}}' \
    "${draft}" "${head_sha}"
}

checks_payload() {
  local promotion="$1"
  local security="$2"
  local version="$3"
  local delta="$4"
  printf '{"check_runs":[
    {"name":"Release train promotion gate","status":"completed","conclusion":"%s"},
    {"name":"Release/security gates","status":"completed","conclusion":"%s"},
    {"name":"Version alignment","status":"completed","conclusion":"%s"},
    {"name":"Release delta validation","status":"completed","conclusion":"%s"}]}' \
    "${promotion}" "${security}" "${version}" "${delta}"
}

calls="${scratch}/calls"
cases=0
failures=0

run_case() {
  local label="$1"
  local expect="$2"
  local checks="$3"
  local draft="$4"
  local sweep="$5"
  local output status=0
  cases=$((cases + 1))
  : >"${calls}"
  local -a args=(--repo o/r --head-branch release-please--branches--premain --pr 7)
  if [[ "${sweep}" == "true" ]]; then
    args+=(--sweep)
  fi
  output="$(GH_BIN="${scratch}/bin/gh" \
    STUB_CHECKS="${checks}" \
    STUB_PR="$(pr_payload "${draft}")" \
    STUB_CALLS="${calls}" \
    RELEASE_PR_CHECK_INTERVAL_SECONDS=1 \
    RELEASE_PR_CHECK_TIMEOUT_SECONDS=6 \
    RELEASE_PR_CHECK_START_TIMEOUT_SECONDS=2 \
    RELEASE_PR_DISPATCH_ATTEMPTS=1 \
    bash scripts/sync-release-pr-checks.sh "${args[@]}" 2>&1)" || status=$?

  case "${expect}" in
    pass)
      if (( status != 0 )) || ! grep -q "PASS" <<<"${output}"; then
        echo "test-sync-release-pr-checks: FAIL ${label} (expected PASS, exit ${status})" >&2
        printf '%s\n' "${output}" >&2
        failures=$((failures + 1))
        return 0
      fi
      ;;
    fail)
      if (( status == 0 )); then
        echo "test-sync-release-pr-checks: FAIL ${label} (expected a failure)" >&2
        printf '%s\n' "${output}" >&2
        failures=$((failures + 1))
        return 0
      fi
      ;;
    warn)
      if (( status != 0 )) || ! grep -q "WARN" <<<"${output}"; then
        echo "test-sync-release-pr-checks: FAIL ${label} (expected a sweep warning, exit ${status})" >&2
        printf '%s\n' "${output}" >&2
        failures=$((failures + 1))
        return 0
      fi
      ;;
  esac
  echo "test-sync-release-pr-checks: PASS ${label}"
}

expect_call() {
  local label="$1"
  local needle="$2"
  local present="$3"
  if [[ "${present}" == "true" ]]; then
    if ! grep -qF -- "${needle}" "${calls}"; then
      echo "test-sync-release-pr-checks: FAIL ${label} (missing '${needle}')" >&2
      failures=$((failures + 1))
      return 0
    fi
  elif grep -qF -- "${needle}" "${calls}"; then
    echo "test-sync-release-pr-checks: FAIL ${label} (unexpected '${needle}')" >&2
    failures=$((failures + 1))
    return 0
  fi
  echo "test-sync-release-pr-checks: PASS ${label}"
}

run_case "green draft head is marked ready" pass "$(checks_payload success success success success)" true false
expect_call "the ready call marks the pull request" "pr ready 7 --repo o/r" true

run_case "an already-ready green head is left alone" pass "$(checks_payload success success success success)" false false
expect_call "an already-ready head is not marked ready again" "pr ready 7 --repo o/r" false

run_case "an already-ready head without the rollup contexts warns" warn "$(checks_payload success success success success)" false false

run_case "a red head is refused" fail "$(checks_payload failure success success success)" true false
expect_call "a red head is never re-dispatched" "workflow run" false

run_case "an all-skipped head is treated as absent and times out" fail "$(checks_payload skipped skipped skipped skipped)" true false
run_case "a missing head dispatches the verifying workflow" fail '{"check_runs":[]}' true false
expect_call "the dispatch names the pull request" "release_pr_number=7" true
expect_call "the dispatch names the head SHA" "release_head_sha=${head_sha}" true

run_case "a skipped required context is not proof" fail "$(checks_payload success success skipped success)" true false
expect_call "a skipped context prompts a dispatch" "workflow run ci.yml" true

run_case "the sweep reports an unrecoverable head instead of failing" warn "$(checks_payload failure success success success)" true true

if (( failures > 0 )); then
  echo "test-sync-release-pr-checks: FAIL (${failures} of ${cases} case(s))" >&2
  exit 1
fi

echo "test-sync-release-pr-checks: PASS (${cases} cases)"
