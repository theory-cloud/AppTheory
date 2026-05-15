#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

release_branch="${1:-}"
if [[ -z "${release_branch}" ]]; then
  echo "sync-release-pr-generated: FAIL (usage: $0 <release-branch>)" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "sync-release-pr-generated: FAIL (gh not found)" >&2
  exit 1
fi

pr_line="$(
  gh pr list \
    --state open \
    --head "${release_branch}" \
    --json number,isDraft \
    --jq '.[] | "\(.number)	\(.isDraft)"' \
    | head -n 1
)"

if [[ -z "${pr_line}" ]]; then
  echo "sync-release-pr-generated: SKIP (no open PR for ${release_branch})"
  exit 0
fi

pr_number="${pr_line%%$'\t'*}"

pr_state_line() {
  gh pr view "${pr_number}" \
    --json state,isDraft,headRefOid \
    --jq '"\(.state)	\(.isDraft)	\(.headRefOid)"' \
    2>/dev/null || true
}

ensure_release_pr_is_draft() {
  local context="$1"
  local current_pr_line
  current_pr_line="$(pr_state_line)"
  if [[ -z "${current_pr_line}" ]]; then
    echo "sync-release-pr-generated: FAIL (PR #${pr_number} disappeared ${context})"
    exit 1
  fi

  local current_pr_state
  local current_pr_is_draft
  current_pr_state="${current_pr_line%%$'\t'*}"
  current_pr_is_draft="${current_pr_line#*$'\t'}"
  current_pr_is_draft="${current_pr_is_draft%%$'\t'*}"

  if [[ "${current_pr_state}" != "OPEN" ]]; then
    echo "sync-release-pr-generated: FAIL (PR #${pr_number} is ${current_pr_state} ${context})"
    exit 1
  fi

  if [[ "${current_pr_is_draft}" != "true" ]]; then
    echo "sync-release-pr-generated: drafting PR #${pr_number} ${context}"
    gh pr ready "${pr_number}" --undo

    current_pr_line="$(pr_state_line)"
    current_pr_is_draft="${current_pr_line#*$'\t'}"
    current_pr_is_draft="${current_pr_is_draft%%$'\t'*}"
    if [[ "${current_pr_is_draft}" != "true" ]]; then
      echo "sync-release-pr-generated: FAIL (PR #${pr_number} could not be made draft ${context})"
      exit 1
    fi
  fi
}

wait_for_required_checks() {
  local timeout_seconds="${RELEASE_PR_CHECK_TIMEOUT_SECONDS:-2400}"
  local interval_seconds="${RELEASE_PR_CHECK_INTERVAL_SECONDS:-15}"
  local required_checks="${RELEASE_PR_READY_CHECKS:-}"
  if [[ -z "${required_checks}" ]]; then
    required_checks=$'Version alignment\nGo (test + vet)\nTypeScript (npm pack)\nPython (build wheel + sdist)\nVerify deterministic builds\nContract tests (fixtures)\nRubric (full gate set)'
  fi

  local deadline=$((SECONDS + timeout_seconds))

  while true; do
    local checks_json
    local checks_file
    checks_file="$(mktemp)"
    if ! gh pr checks "${pr_number}" --json name,bucket,startedAt,completedAt,workflow >"${checks_file}" 2>/dev/null; then
      # `gh pr checks` exits 8 while checks are pending, but still prints the
      # JSON payload. Only synthesize an empty payload when no JSON was emitted.
      if [[ ! -s "${checks_file}" ]]; then
        printf '[]' >"${checks_file}"
      fi
    fi
    checks_json="$(cat "${checks_file}")"
    rm -f "${checks_file}"

    local status_file
    status_file="$(mktemp)"
    CHECKS_JSON="${checks_json}" REQUIRED_CHECKS="${required_checks}" python3 - >"${status_file}" <<'PY'
import json
import os

checks = json.loads(os.environ.get("CHECKS_JSON") or "[]")
required = [line for line in os.environ["REQUIRED_CHECKS"].splitlines() if line]

latest = {}
for check in checks:
    name = check.get("name", "")
    if name not in required:
        continue
    # `gh pr checks` can report multiple workflow runs for the same PR head.
    # Keep the newest status per required check.
    timestamp = check.get("startedAt") or check.get("completedAt") or ""
    if name not in latest or timestamp >= latest[name][0]:
        latest[name] = (timestamp, check)

missing = []
pending = []
failed = []

for name in required:
    record = latest.get(name)
    if record is None:
        missing.append(name)
        continue
    bucket = record[1].get("bucket", "")
    if bucket == "pass":
        continue
    if bucket in {"pending", "skipping", ""}:
        pending.append(f"{name}={bucket or 'pending'}")
        continue
    failed.append(f"{name}={bucket}")

if failed:
    print("fail")
    print("failed: " + ", ".join(failed))
elif missing or pending:
    print("pending")
    if missing:
        print("missing: " + ", ".join(missing))
    if pending:
        print("pending: " + ", ".join(pending))
else:
    print("pass")
PY

    local status
    status="$(head -n 1 "${status_file}")"
    local details
    details="$(tail -n +2 "${status_file}")"
    rm -f "${status_file}"

    case "${status}" in
      pass)
        echo "sync-release-pr-generated: required checks passed for PR #${pr_number}"
        return 0
        ;;
      fail)
        echo "sync-release-pr-generated: FAIL (required checks failed for PR #${pr_number})"
        if [[ -n "${details}" ]]; then
          echo "${details}"
        fi
        return 1
        ;;
      pending)
        if (( SECONDS >= deadline )); then
          echo "sync-release-pr-generated: FAIL (timed out waiting for required checks on PR #${pr_number})"
          if [[ -n "${details}" ]]; then
            echo "${details}"
          fi
          return 1
        fi
        echo "sync-release-pr-generated: waiting for required checks on PR #${pr_number}"
        if [[ -n "${details}" ]]; then
          echo "${details}"
        fi
        sleep "${interval_seconds}"
        ;;
      *)
        echo "sync-release-pr-generated: FAIL (could not read required check status for PR #${pr_number})"
        return 1
        ;;
    esac
  done
}

wait_for_required_checks_to_start() {
  local timeout_seconds="${RELEASE_PR_CHECK_START_TIMEOUT_SECONDS:-300}"
  local interval_seconds="${RELEASE_PR_CHECK_INTERVAL_SECONDS:-15}"
  local required_checks="${RELEASE_PR_READY_CHECKS:-}"
  if [[ -z "${required_checks}" ]]; then
    required_checks=$'Version alignment\nGo (test + vet)\nTypeScript (npm pack)\nPython (build wheel + sdist)\nVerify deterministic builds\nContract tests (fixtures)\nRubric (full gate set)'
  fi

  local deadline=$((SECONDS + timeout_seconds))

  while true; do
    local checks_json
    local checks_file
    checks_file="$(mktemp)"
    if ! gh pr checks "${pr_number}" --json name,bucket,startedAt,completedAt,workflow >"${checks_file}" 2>/dev/null; then
      # `gh pr checks` exits 8 while checks are pending, but still prints the
      # JSON payload. Only synthesize an empty payload when no JSON was emitted.
      if [[ ! -s "${checks_file}" ]]; then
        printf '[]' >"${checks_file}"
      fi
    fi
    checks_json="$(cat "${checks_file}")"
    rm -f "${checks_file}"

    local status_file
    status_file="$(mktemp)"
    CHECKS_JSON="${checks_json}" REQUIRED_CHECKS="${required_checks}" python3 - >"${status_file}" <<'PY'
import json
import os

checks = json.loads(os.environ.get("CHECKS_JSON") or "[]")
required = [line for line in os.environ["REQUIRED_CHECKS"].splitlines() if line]
seen = {check.get("name", "") for check in checks}
missing = [name for name in required if name not in seen]

if missing:
    print("pending")
    print("missing: " + ", ".join(missing))
else:
    print("pass")
PY

    local status
    status="$(head -n 1 "${status_file}")"
    local details
    details="$(tail -n +2 "${status_file}")"
    rm -f "${status_file}"

    case "${status}" in
      pass)
        echo "sync-release-pr-generated: required checks queued for PR #${pr_number}"
        return 0
        ;;
      pending)
        if (( SECONDS >= deadline )); then
          echo "sync-release-pr-generated: FAIL (timed out waiting for required checks to queue on PR #${pr_number})"
          if [[ -n "${details}" ]]; then
            echo "${details}"
          fi
          return 1
        fi
        echo "sync-release-pr-generated: waiting for required checks to queue on PR #${pr_number}"
        if [[ -n "${details}" ]]; then
          echo "${details}"
        fi
        sleep "${interval_seconds}"
        ;;
      *)
        echo "sync-release-pr-generated: FAIL (could not read required check queue status for PR #${pr_number})"
        return 1
        ;;
    esac
  done
}

wait_for_pr_head() {
  local expected_head="$1"
  local timeout_seconds="${RELEASE_PR_HEAD_TIMEOUT_SECONDS:-300}"
  local interval_seconds="${RELEASE_PR_CHECK_INTERVAL_SECONDS:-15}"
  local deadline=$((SECONDS + timeout_seconds))

  while true; do
    local current_pr_line
    current_pr_line="$(pr_state_line)"
    if [[ -z "${current_pr_line}" ]]; then
      echo "sync-release-pr-generated: FAIL (PR #${pr_number} disappeared before head ${expected_head} was visible)"
      exit 1
    fi

    local current_pr_state
    local current_pr_head
    current_pr_state="${current_pr_line%%$'\t'*}"
    current_pr_head="${current_pr_line##*$'\t'}"

    if [[ "${current_pr_state}" != "OPEN" ]]; then
      echo "sync-release-pr-generated: FAIL (PR #${pr_number} is ${current_pr_state} before head ${expected_head} was visible)"
      exit 1
    fi

    if [[ "${current_pr_head}" == "${expected_head}" ]]; then
      echo "sync-release-pr-generated: PR #${pr_number} head is ${expected_head}"
      return 0
    fi

    if (( SECONDS >= deadline )); then
      echo "sync-release-pr-generated: FAIL (timed out waiting for PR #${pr_number} head ${expected_head}; current ${current_pr_head})"
      exit 1
    fi

    echo "sync-release-pr-generated: waiting for PR #${pr_number} head ${expected_head} (current ${current_pr_head})"
    sleep "${interval_seconds}"
  done
}

trigger_release_pr_checks() {
  # Release PRs stay draft while generated artifacts are being rewritten so they
  # cannot be merged in an incomplete state. CI still needs a pull_request event
  # after the generated-artifact commit is visible, so briefly move the PR to
  # ready_for_review, then immediately draft-lock it again before waiting for
  # the required checks to complete.
  ensure_release_pr_is_draft "before triggering generated-artifact checks"

  echo "sync-release-pr-generated: triggering checks for PR #${pr_number}"
  gh pr ready "${pr_number}"

  # Keep the PR ready only until the required check contexts exist, then
  # immediately draft-lock it again while those checks run.
  wait_for_required_checks_to_start
  ensure_release_pr_is_draft "after triggering generated-artifact checks"
}

# The release PR must not be mergeable while generated artifacts are still being
# rewritten. This is the release-lane invariant: release-please version files and
# generated CDK/jsii artifacts land in the same release PR before it becomes
# ready for review.
ensure_release_pr_is_draft "before generated artifacts are synced"

git fetch origin "${release_branch}"
git switch --detach FETCH_HEAD

scripts/update-cdk-generated.sh >/dev/null

changed=false
if ! git diff --quiet -- cdk/.jsii cdk/lib cdk-go/apptheorycdk; then
  changed=true

  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git add cdk/.jsii cdk/lib cdk-go/apptheorycdk
  git commit -m "chore(release): sync generated cdk artifacts"
fi

go test ./cdk-go/apptheorycdk

ensure_release_pr_is_draft "before generated artifacts are pushed"

if [[ "${changed}" == "true" ]]; then
  git push origin HEAD:"${release_branch}"
fi

wait_for_pr_head "$(git rev-parse HEAD)"
# After the generated-artifact head is visible, trigger PR checks while
# preserving the draft-lock before waiting on them.
trigger_release_pr_checks
wait_for_required_checks

ensure_release_pr_is_draft "before marking generated-artifact-synced PR ready"
gh pr ready "${pr_number}"

echo "sync-release-pr-generated: PASS (${release_branch} updated)"
