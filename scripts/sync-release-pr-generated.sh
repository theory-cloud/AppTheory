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

repo_full_name() {
  if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
    echo "${GITHUB_REPOSITORY}"
    return 0
  fi

  gh repo view --json nameWithOwner --jq '.nameWithOwner'
}

collect_check_records() {
  local current_pr_line
  current_pr_line="$(pr_state_line)"
  if [[ -z "${current_pr_line}" ]]; then
    echo "sync-release-pr-generated: FAIL (PR #${pr_number} disappeared while reading checks)" >&2
    return 1
  fi

  local current_pr_state
  local current_pr_head
  current_pr_state="${current_pr_line%%$'\t'*}"
  current_pr_head="${current_pr_line##*$'\t'}"

  if [[ "${current_pr_state}" != "OPEN" ]]; then
    echo "sync-release-pr-generated: FAIL (PR #${pr_number} is ${current_pr_state} while reading checks)" >&2
    return 1
  fi

  local pr_checks_file
  pr_checks_file="$(mktemp)"
  if ! gh pr checks "${pr_number}" --json name,bucket,startedAt,completedAt,workflow >"${pr_checks_file}" 2>/dev/null; then
    # `gh pr checks` exits 8 while checks are pending, but still prints the
    # JSON payload. It can also report no checks for workflow_dispatch runs that
    # are attached to the commit but not surfaced through the PR checks view.
    if [[ ! -s "${pr_checks_file}" ]]; then
      printf '[]' >"${pr_checks_file}"
    fi
  fi

  local repo
  repo="$(repo_full_name)"

  local commit_checks_file
  commit_checks_file="$(mktemp)"
  if ! gh api "repos/${repo}/commits/${current_pr_head}/check-runs?per_page=100" \
    --jq '[.check_runs[] | {
      name: .name,
      bucket: (
        if .status != "completed" then "pending"
        elif (.conclusion == "success" or .conclusion == "neutral") then "pass"
        elif .conclusion == "skipped" then "skipping"
        else .conclusion
        end
      ),
      startedAt: (.started_at // ""),
      completedAt: (.completed_at // ""),
      workflow: (.app.slug // "github-actions")
    }]' >"${commit_checks_file}" 2>/dev/null; then
    printf '[]' >"${commit_checks_file}"
  fi

  PR_CHECKS_JSON="$(cat "${pr_checks_file}")" \
    COMMIT_CHECKS_JSON="$(cat "${commit_checks_file}")" \
    python3 - <<'PY'
import json
import os


def load(name: str) -> list[dict]:
    try:
        data = json.loads(os.environ.get(name) or "[]")
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


print(json.dumps(load("PR_CHECKS_JSON") + load("COMMIT_CHECKS_JSON"), separators=(",", ":")))
PY

  rm -f "${pr_checks_file}" "${commit_checks_file}"
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
    checks_json="$(collect_check_records)"

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
    checks_json="$(collect_check_records)"

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

dispatch_required_checks() {
  local required_check_workflow="${RELEASE_PR_CHECK_WORKFLOW:-ci.yml}"

  echo "sync-release-pr-generated: dispatching ${required_check_workflow} for ${release_branch}"
  if ! gh workflow run "${required_check_workflow}" --ref "${release_branch}"; then
    echo "sync-release-pr-generated: FAIL (could not dispatch ${required_check_workflow} for ${release_branch})"
    exit 1
  fi
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

sync_stable_release_premain_manifest() {
  if [[ "${release_branch}" != "release-please--branches--main" ]]; then
    return 0
  fi

  local stable_version
  stable_version="$(./scripts/read-version.sh)"
  if [[ -z "${stable_version}" ]]; then
    echo "sync-release-pr-generated: FAIL (could not read stable release version)"
    exit 1
  fi

  STABLE_VERSION="${stable_version}" python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(".release-please-manifest.premain.json")
data = json.loads(path.read_text(encoding="utf-8"))
data["."] = os.environ["STABLE_VERSION"]
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
}

# The release PR must not be mergeable while generated artifacts are still being
# rewritten. This is the release-lane invariant: release-please version files and
# generated CDK/jsii artifacts land in the same release PR before it becomes
# ready for review.
ensure_release_pr_is_draft "before generated artifacts are synced"

git fetch origin "${release_branch}"
git switch --detach FETCH_HEAD

sync_stable_release_premain_manifest
scripts/update-cdk-generated.sh >/dev/null

changed=false
if ! git diff --quiet -- .release-please-manifest.premain.json cdk/.jsii cdk/lib cdk-go/apptheorycdk; then
  changed=true

  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git add .release-please-manifest.premain.json cdk/.jsii cdk/lib cdk-go/apptheorycdk
  git commit -m "chore(release): sync generated release artifacts"
fi

go test ./cdk-go/apptheorycdk

ensure_release_pr_is_draft "before generated artifacts are pushed"

if [[ "${changed}" == "true" ]]; then
  git push origin HEAD:"${release_branch}"
fi

wait_for_pr_head "$(git rev-parse HEAD)"
# After the generated-artifact head is visible, rely only on independent PR
# checks for protected required contexts. Bot-authored release PR updates can be
# suppressed by GitHub's recursive workflow guard, so explicitly dispatch CI on
# the release branch instead of self-attesting protected statuses from mutable
# release-branch code.
ensure_release_pr_is_draft "before waiting for independent required checks"
dispatch_required_checks
wait_for_required_checks_to_start
wait_for_required_checks

ensure_release_pr_is_draft "before marking generated-artifact-synced PR ready"
gh pr ready "${pr_number}"

echo "sync-release-pr-generated: PASS (${release_branch} updated)"
