#!/usr/bin/env bash
set -euo pipefail

# Attach the required release checks to a generated release pull request without
# a human action.
#
# release-please opens and updates its pull request with a token that starts no
# `pull_request` workflow, so the generated release pull request never gets its
# required contexts on its own. `workflow_dispatch` is the documented exception,
# so this lane dispatches the verifying workflow against the release branch and
# holds it to the exact pull request head.
#
# The lane is deliberately conservative:
#
#   - declaration-driven: `.github/release-lane.json` names, per release branch,
#     the required contexts and the workflow that reports each one, so the lane
#     and scripts/verify-release-pr-check-lane.sh cannot drift apart;
#   - idempotent: a green context at the head is reused and nothing is
#     re-dispatched; a red context stops the lane instead of being re-run until
#     it happens to pass;
#   - head-checked: every decision is taken against the pull request's current
#     head, the dispatch carries that head SHA, and a head that moves during the
#     wait sends the lane back to verify the new head;
#   - draft-locked: the pull request stays a draft until the required contexts
#     are green at one head, and it is marked ready only after a final head read
#     proves that head has not moved.
#
# It never merges, never commits, never rewrites a branch, and never creates a
# credential. Reads and the dispatch use the built-in token.
#
# `--sweep` is the recovery mode used by the scheduled sweep: it reports a red
# or timed-out head instead of failing the scheduled run, because the failure is
# already visible on the pull request and a scheduled run has no reviewer. It
# still refuses to re-dispatch around a red check.

usage() {
  cat <<'USAGE'
Usage: bash scripts/sync-release-pr-checks.sh --head-branch BRANCH [options]

Options:
  --repo OWNER/REPO        Repository. Defaults to $GITHUB_REPOSITORY or theory-cloud/AppTheory.
  --head-branch BRANCH     Generated release branch this run updated (required).
  --pr NUMBER              Pull request number; discovered from the branch when omitted.
  --config FILE            Release-lane declaration. Defaults to .github/release-lane.json.
  --sweep                  Report-only recovery mode for the scheduled sweep.
  -h, --help               Show this help.

Environment:
  RELEASE_PR_CHECK_TIMEOUT_SECONDS        Overall wait budget (default 2400).
  RELEASE_PR_CHECK_START_TIMEOUT_SECONDS  Wait budget for a dispatch to report (default 300).
  RELEASE_PR_CHECK_INTERVAL_SECONDS       Poll interval (default 20).
  RELEASE_PR_DISPATCH_ATTEMPTS            Maximum dispatches per head (default 2).
  GH_BIN                                  gh binary to use (default gh); a test seam.
USAGE
}

repo="${GITHUB_REPOSITORY:-theory-cloud/AppTheory}"
head_branch=""
pr_number=""
config=".github/release-lane.json"
sweep=false
gh_bin="${GH_BIN:-gh}"
timeout_seconds="${RELEASE_PR_CHECK_TIMEOUT_SECONDS:-2400}"
start_timeout_seconds="${RELEASE_PR_CHECK_START_TIMEOUT_SECONDS:-300}"
interval_seconds="${RELEASE_PR_CHECK_INTERVAL_SECONDS:-20}"
max_dispatch_attempts="${RELEASE_PR_DISPATCH_ATTEMPTS:-2}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || { echo "sync-release-pr-checks: FAIL (--repo requires a value)" >&2; exit 2; }
      repo="$2"
      shift 2
      ;;
    --head-branch)
      [[ $# -ge 2 ]] || { echo "sync-release-pr-checks: FAIL (--head-branch requires a value)" >&2; exit 2; }
      head_branch="$2"
      shift 2
      ;;
    --pr)
      [[ $# -ge 2 ]] || { echo "sync-release-pr-checks: FAIL (--pr requires a value)" >&2; exit 2; }
      pr_number="$2"
      shift 2
      ;;
    --config)
      [[ $# -ge 2 ]] || { echo "sync-release-pr-checks: FAIL (--config requires a value)" >&2; exit 2; }
      config="$2"
      shift 2
      ;;
    --sweep)
      sweep=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "sync-release-pr-checks: FAIL (unknown argument: $1)" >&2
      exit 2
      ;;
  esac
done

fail() {
  echo "sync-release-pr-checks: FAIL ($1)" >&2
  exit 1
}

report_unrecovered() {
  # In sweep mode the head is already visibly red or stuck on the pull request;
  # a scheduled run has no reviewer to fail for, and re-dispatching around a red
  # check is the one thing this lane must never do.
  if [[ "${sweep}" == "true" ]]; then
    echo "sync-release-pr-checks: WARN ($1; the sweep never re-dispatches around it, and the pull request shows the same state)" >&2
    exit 0
  fi
  fail "$1"
}

[[ -n "${head_branch}" ]] || fail "--head-branch is required"

# The declaration is the single source of truth: the same file drives the static
# guard in scripts/verify-release-pr-check-lane.sh, so a workflow and its policy
# cannot drift apart.
lane="$(LANE_HEAD_BRANCH="${head_branch}" python3 - "${config}" <<'PY'
import json
import os
import sys

path = sys.argv[1]
head_branch = os.environ["LANE_HEAD_BRANCH"]
try:
    data = json.loads(open(path, encoding="utf-8").read())
except FileNotFoundError:
    print(f"sync-release-pr-checks: FAIL (missing release-lane declaration {path})", file=sys.stderr)
    raise SystemExit(1)

entries = [item for item in data.get("generatedReleasePullRequests") or [] if item.get("head") == head_branch]
if len(entries) != 1:
    print(
        f"sync-release-pr-checks: FAIL ({path} declares {len(entries)} generated release pull requests for {head_branch})",
        file=sys.stderr,
    )
    raise SystemExit(1)
entry = entries[0]
base = str(entry.get("base") or "")
if not base:
    print(f"sync-release-pr-checks: FAIL ({head_branch} entry declares no base)", file=sys.stderr)
    raise SystemExit(1)
required = [item for item in (data.get("requiredContexts") or {}).get(base) or [] if item.get("context")]
if not required:
    print(f"sync-release-pr-checks: FAIL ({path} declares no required context for {base})", file=sys.stderr)
    raise SystemExit(1)
print(f"base={base}")
for item in required:
    print(f"context\t{item['context']}\t{item['workflow']}\t{item.get('job') or ''}")
PY
)" || exit 1

base="$(printf '%s\n' "${lane}" | awk -F= '$1 == "base" { print $2 }')"
mapfile -t context_rows < <(printf '%s\n' "${lane}" | awk -F'\t' '$1 == "context"')

[[ -n "${base}" ]] || fail "could not resolve the release branch for ${head_branch}"
(( ${#context_rows[@]} > 0 )) || fail "could not resolve the required contexts for ${base}"

read_pr() {
  "${gh_bin}" api "repos/${repo}/pulls/${pr_number}" || fail "cannot read pull request #${pr_number}"
}

project_pr() {
  PR_JSON="${1}" python3 - <<'PY'
import json
import os

data = json.loads(os.environ["PR_JSON"])
head = data.get("head") or {}
print(f"state={str(data.get('state') or '')}")
print(f"draft={'true' if data.get('draft') else 'false'}")
print(f"head_sha={str(head.get('sha') or '')}")
PY
}

# Every request is bounded: an unknown or empty answer is retried once and then
# fails closed instead of being read as "no checks" or "no pull request".
request_with_retries() {
  local description="$1"
  shift
  local attempt=1
  local out
  while true; do
    if out="$("$@" 2>/dev/null)"; then
      printf '%s' "${out}"
      return 0
    fi
    if (( attempt >= 2 )); then
      echo "sync-release-pr-checks: FAIL (cannot ${description})" >&2
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
}

discover_pr() {
  local discovered count
  discovered="$(request_with_retries "list open ${head_branch} pull requests" \
    "${gh_bin}" pr list \
    --repo "${repo}" \
    --state open \
    --base "${base}" \
    --head "${head_branch}" \
    --json number \
    --jq '.[].number')" || return 1
  count="$(printf '%s' "${discovered}" | grep -c . || true)"
  case "${count}" in
    1)
      printf '%s\n' "${discovered}" | head -n 1
      ;;
    0)
      return 2
      ;;
    *)
      fail "more than one open ${head_branch} pull request targets ${base}"
      ;;
  esac
}

if [[ -z "${pr_number}" ]]; then
  set +e
  pr_number="$(discover_pr)"
  discovered_status=$?
  set -e
  case "${discovered_status}" in
    0) ;;
    2)
      echo "sync-release-pr-checks: no open ${head_branch} pull request targets ${base}; nothing to check" >&2
      exit 0
      ;;
    *) exit 1 ;;
  esac
fi
[[ "${pr_number}" =~ ^[0-9]+$ ]] || fail "pull request number must be numeric, got ${pr_number}"

pr_field() {
  local projected="$1"
  local key="$2"
  awk -F= -v key="${key}" '$1 == key { print $2 }' <<<"${projected}"
}

ensure_open() {
  local projected="$1"
  local state
  state="$(pr_field "${projected}" state)"
  case "${state}" in
    open) ;;
    merged|closed)
      echo "sync-release-pr-checks: PR #${pr_number} is ${state}; the lane has nothing left to gate" >&2
      exit 0
      ;;
    *)
      fail "PR #${pr_number} is ${state:-unknown}"
      ;;
  esac
}

ensure_draft() {
  local projected draft state
  projected="$(project_pr "$(read_pr)")"
  ensure_open "${projected}"
  draft="$(pr_field "${projected}" draft)"
  if [[ "${draft}" == "true" ]]; then
    return 0
  fi
  echo "sync-release-pr-checks: draft-locking PR #${pr_number} before the required checks run" >&2
  "${gh_bin}" pr ready "${pr_number}" --repo "${repo}" --undo >/dev/null
  projected="$(project_pr "$(read_pr)")"
  ensure_open "${projected}"
  draft="$(pr_field "${projected}" draft)"
  [[ "${draft}" == "true" ]] || fail "PR #${pr_number} could not be draft-locked"
}

# Report pass|fail|pending|none for every required context at one head. A
# context with no check run and no in-flight run of its workflow is "none": the
# dispatch is genuinely missing, not red and not queued. A skipped required
# context is never treated as proof: the declared contexts all run on a
# dispatched verification, so a skip means the wiring moved.
classify_at_head() {
  local head_sha="$1"
  local checks_json runs_json
  checks_json="$(request_with_retries "read check runs at ${head_sha}" \
    "${gh_bin}" api "repos/${repo}/commits/${head_sha}/check-runs?filter=latest&per_page=100")" || {
    echo "unknown"
    return 1
  }
  runs_json="$(request_with_retries "read workflow runs at ${head_sha}" \
    "${gh_bin}" api "repos/${repo}/actions/runs?head_sha=${head_sha}&per_page=100")" || {
    echo "unknown"
    return 1
  }

  CHECKS_JSON="${checks_json}" RUNS_JSON="${runs_json}" python3 - "${context_rows[@]}" <<'PY'
import json
import os
import sys

checks = json.loads(os.environ["CHECKS_JSON"]).get("check_runs") or []
runs = json.loads(os.environ["RUNS_JSON"]).get("workflow_runs") or []
PASS = {"success", "neutral"}
FAIL = {"failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure"}

by_name: dict[str, list[dict]] = {}
for check in checks:
    by_name.setdefault(str(check.get("name") or ""), []).append(check)

by_path: dict[str, list[dict]] = {}
for run in runs:
    by_path.setdefault(str(run.get("path") or ""), []).append(run)

failed: list[str] = []
pending: list[str] = []
missing: list[str] = []
seen = 0

for row in sys.argv[1:]:
    _, context, workflow, _job = row.split("\t")
    records = by_name.get(context) or []
    if records:
        seen += 1
    in_flight = [
        run
        for run in by_path.get(f".github/workflows/{workflow}", [])
        if str(run.get("status") or "") != "completed"
    ]

    # A skipped job is not proof: every declared context is designed to run on a
    # dispatched verification, so a skip means the wiring moved. Treat it as an
    # absent verdict (dispatch) instead of a green one, and never as a red one
    # that would strand the pull request behind a lane refusal.
    conclusions = {str(record.get("conclusion") or "") for record in records}
    if conclusions & PASS:
        continue
    if conclusions & FAIL:
        failed.append(f"{context}={'+'.join(sorted(conclusions & FAIL))}")
        continue
    if records and all(record.get("status") == "completed" for record in records) and conclusions <= {"skipped"}:
        if in_flight:
            pending.append(context)
        else:
            missing.append(context)
        continue
    if records or in_flight:
        pending.append(context)
        continue
    missing.append(context)

if failed:
    print("fail")
    print("failed: " + ", ".join(failed))
elif missing:
    print("none")
    print("missing: " + ", ".join(missing))
elif pending:
    print("pending")
    print("pending: " + ", ".join(pending))
else:
    print("pass")
print(f"seen={seen}")
PY
}

# One dispatch per distinct verifying workflow, carrying the pull request number
# and the exact head SHA the lane just read. A run whose dispatched ref no longer
# matches the recorded head SHA fails closed in the verifying workflow instead of
# certifying a tree the pull request does not contain.
dispatch_contexts() {
  local head_sha="$1"
  local row context workflow job
  local dispatched=" "
  for row in "${context_rows[@]}"; do
    IFS=$'\t' read -r _ context workflow job <<<"${row}"
    case "${dispatched}" in
      *" ${workflow} "*) continue ;;
    esac
    dispatched="${dispatched}${workflow} "
    echo "sync-release-pr-checks: dispatching ${workflow} for ${head_branch} to verify ${context} at PR #${pr_number} head ${head_sha}" >&2
    "${gh_bin}" workflow run "${workflow}" \
      --repo "${repo}" \
      --ref "${head_branch}" \
      -f "release_pr_number=${pr_number}" \
      -f "release_head_sha=${head_sha}" || {
      fail "could not dispatch ${workflow} for ${head_branch}"
    }
  done
}

rollup_reports_contexts() {
  local rollup_json
  rollup_json="$("${gh_bin}" pr view "${pr_number}" --repo "${repo}" --json statusCheckRollup 2>/dev/null || echo '{"statusCheckRollup":null}')"
  ROLLUP_JSON="${rollup_json}" python3 - "${context_rows[@]}" <<'PY'
import json
import os
import sys

data = json.loads(os.environ["ROLLUP_JSON"]).get("statusCheckRollup")
if data is None:
    print("absent")
    raise SystemExit(0)
names = {str(item.get("name") or item.get("context") or "") for item in data}
wanted = [row.split("\t")[1] for row in sys.argv[1:]]
print("present" if all(name in names for name in wanted) else "absent")
PY
}

deadline=$((SECONDS + timeout_seconds))
start_deadline=0
dispatch_attempts=0
dispatched_head=""

while :; do
  projected="$(project_pr "$(read_pr)")"
  ensure_open "${projected}"
  head_sha="$(pr_field "${projected}" head_sha)"
  [[ "${head_sha}" =~ ^[0-9a-f]{40}$ ]] || fail "PR #${pr_number} head is not a commit SHA"

  if [[ "${head_sha}" != "${dispatched_head}" ]]; then
    dispatch_attempts=0
    dispatched_head="${head_sha}"
    start_deadline=0
  fi

  status_file="$(mktemp)"
  classify_at_head "${head_sha}" >"${status_file}" || true
  status="$(head -n 1 "${status_file}")"
  details="$(sed -n '2{/^seen=/!p}' "${status_file}")"
  seen="$(awk -F= '$1 == "seen" { print $2 }' "${status_file}")"
  rm -f "${status_file}"
  seen="${seen:-0}"

  # A required context that has reported at this head means the dispatch landed;
  # from here only the overall wait budget applies.
  if [[ "${status}" == "pass" || "${status}" == "fail" ]] || (( seen > 0 )); then
    start_deadline=0
  fi

  case "${status}" in
    pass)
      # The head that passed is the head that gets marked ready. A head that
      # moved since the check ran is re-read here and verified again by the next
      # iteration instead of being certified on stale proof.
      if [[ "$(pr_field "$(project_pr "$(read_pr)")" head_sha)" != "${head_sha}" ]]; then
        echo "sync-release-pr-checks: head moved while ${head_sha} was green; verifying the new head" >&2
        continue
      fi
      echo "sync-release-pr-checks: required checks are green at ${head_sha}"
      break
      ;;
    fail)
      report_unrecovered "required checks already failed at ${head_sha}; the lane never re-dispatches around a red check${details:+ (${details})}"
      ;;
    none)
      if (( dispatch_attempts >= max_dispatch_attempts )); then
        report_unrecovered "dispatched ${dispatch_attempts} times and still no required check at ${head_sha}${details:+ (${details})}"
      fi
      dispatch_attempts=$((dispatch_attempts + 1))
      ensure_draft
      dispatch_contexts "${head_sha}"
      start_deadline=$((SECONDS + start_timeout_seconds))
      sleep "${interval_seconds}"
      ;;
    pending)
      if (( SECONDS >= deadline )); then
        report_unrecovered "timed out waiting for required checks at ${head_sha}${details:+ (${details})}"
      fi
      if (( start_deadline > 0 && SECONDS >= start_deadline )); then
        report_unrecovered "timed out waiting for the dispatched checks to report at ${head_sha}${details:+ (${details})}"
      fi
      ensure_draft
      echo "sync-release-pr-checks: waiting for required checks at ${head_sha} (${details:-pending})" >&2
      sleep "${interval_seconds}"
      ;;
    *)
      fail "could not read required check status at ${head_sha}"
      ;;
  esac
done

projected="$(project_pr "$(read_pr)")"
ensure_open "${projected}"
if [[ "$(pr_field "${projected}" draft)" == "false" ]]; then
  echo "sync-release-pr-checks: PASS (PR #${pr_number} already ready at ${head_sha} with green required checks)"
  exit 0
fi

echo "sync-release-pr-checks: marking PR #${pr_number} ready at ${head_sha}"
"${gh_bin}" pr ready "${pr_number}" --repo "${repo}" >/dev/null

ready_head="$(pr_field "$(project_pr "$(read_pr)")" head_sha)"
if [[ "${ready_head}" != "${head_sha}" ]]; then
  "${gh_bin}" pr ready "${pr_number}" --repo "${repo}" --undo >/dev/null || true
  fail "PR #${pr_number} head changed while marking ready; restored the draft lock"
fi

# The commit-level check runs are what the ruleset evaluates. The pull-request
# rollup is a GitHub-side projection of them, and it can lag or drop a context
# after a close and reopen, so a missing rollup entry is reported rather than
# treated as a missing check.
if [[ "$(rollup_reports_contexts)" != "present" ]]; then
  echo "sync-release-pr-checks: WARN (PR #${pr_number} rollup does not list every required context yet; the check runs exist at ${head_sha}, which is what the ruleset evaluates)" >&2
fi

echo "sync-release-pr-checks: PASS (PR #${pr_number} ready at ${head_sha} with green required checks)"
