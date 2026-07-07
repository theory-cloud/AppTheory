#!/usr/bin/env bash
# Purpose: synchronize generated artifacts on release-please PR branches.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

artifact_sync_commit_message="chore(release): sync generated release artifacts"

default_required_checks() {
  cat <<'EOF'
Version alignment
Go (test + vet)
TypeScript (npm pack)
Python (build wheel + sdist)
Contract tests (fixtures)
EOF
}

release_pr_required_checks() {
  if [[ -n "${RELEASE_PR_READY_CHECKS:-}" ]]; then
    printf '%s\n' "${RELEASE_PR_READY_CHECKS}"
    return 0
  fi
  default_required_checks
}

classify_required_checks() {
  python3 - <<'PY'
import json
import os

PASS_BUCKETS = {"pass", "success", "neutral"}
PENDING_BUCKETS = {"pending", "skipping", ""}


def load_checks() -> list[dict]:
    try:
        data = json.loads(os.environ.get("CHECKS_JSON") or "[]")
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def normalize_bucket(record: dict) -> str:
    bucket = record.get("bucket", "")
    if bucket is None:
        return ""
    return str(bucket)


checks = load_checks()
required = [line for line in os.environ["REQUIRED_CHECKS"].splitlines() if line]
records_by_name = {name: [] for name in required}

for check in checks:
    name = check.get("name", "")
    if name in records_by_name:
        records_by_name[name].append(check)

missing = []
pending = []
failed = []

for name in required:
    records = records_by_name[name]
    if not records:
        missing.append(name)
        continue

    buckets = [normalize_bucket(record) for record in records]
    failing_buckets = sorted({bucket for bucket in buckets if bucket not in PASS_BUCKETS | PENDING_BUCKETS})
    if failing_buckets:
        failed.append(f"{name}={'+'.join(failing_buckets)}")
        continue

    if any(bucket in PASS_BUCKETS for bucket in buckets):
        continue

    waiting_buckets = sorted({bucket or "pending" for bucket in buckets})
    pending.append(f"{name}={'+'.join(waiting_buckets) if waiting_buckets else 'pending'}")

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
}

run_required_check_classifier_self_test() {
  local required_check=$'Required Check'

  run_case() {
    local label="$1"
    local description="$2"
    local expected="$3"
    local checks_json="$4"
    local status_file
    status_file="$(mktemp)"

    CHECKS_JSON="${checks_json}" REQUIRED_CHECKS="${required_check}" classify_required_checks >"${status_file}"

    local status
    status="$(head -n 1 "${status_file}")"
    local details
    details="$(tail -n +2 "${status_file}")"
    rm -f "${status_file}"

    if [[ "${status}" != "${expected}" ]]; then
      echo "sync-release-pr-generated self-test: FAIL ${label} (${description}); expected ${expected}, got ${status}" >&2
      if [[ -n "${details}" ]]; then
        echo "${details}" >&2
      fi
      exit 1
    fi

    echo "sync-release-pr-generated self-test: PASS ${label} (${description}) -> ${status}"
    if [[ -n "${details}" ]]; then
      echo "${details}"
    fi
  }

  local skipped_newer_success_older
  skipped_newer_success_older="$(cat <<'JSON'
[
  {
    "name": "Required Check",
    "bucket": "pass",
    "startedAt": "2026-06-19T00:00:00Z",
    "completedAt": "2026-06-19T00:01:00Z",
    "headSha": "synthetic"
  },
  {
    "name": "Required Check",
    "bucket": "skipping",
    "startedAt": "2026-06-19T00:02:00Z",
    "completedAt": "2026-06-19T00:02:01Z",
    "headSha": "synthetic"
  }
]
JSON
)"
  run_case "A" "skipped newer + success older is satisfied" "pass" "${skipped_newer_success_older}"

  local skipped_only
  skipped_only="$(cat <<'JSON'
[
  {
    "name": "Required Check",
    "bucket": "skipping",
    "startedAt": "2026-06-19T00:02:00Z",
    "completedAt": "2026-06-19T00:02:01Z",
    "headSha": "synthetic"
  }
]
JSON
)"
  run_case "B" "skipped only is not satisfied" "pending" "${skipped_only}"

  local failure_instance
  failure_instance="$(cat <<'JSON'
[
  {
    "name": "Required Check",
    "bucket": "pass",
    "startedAt": "2026-06-19T00:00:00Z",
    "completedAt": "2026-06-19T00:01:00Z",
    "headSha": "synthetic"
  },
  {
    "name": "Required Check",
    "bucket": "failure",
    "startedAt": "2026-06-19T00:03:00Z",
    "completedAt": "2026-06-19T00:03:01Z",
    "headSha": "synthetic"
  }
]
JSON
)"
  run_case "C" "any failure instance fails" "fail" "${failure_instance}"

  local success_only
  success_only="$(cat <<'JSON'
[
  {
    "name": "Required Check",
    "bucket": "pass",
    "startedAt": "2026-06-19T00:00:00Z",
    "completedAt": "2026-06-19T00:01:00Z",
    "headSha": "synthetic"
  }
]
JSON
)"
  run_case "D" "success only is satisfied" "pass" "${success_only}"

  echo "sync-release-pr-generated self-test: PASS"
}

is_ci_environment() {
  [[ "${GITHUB_ACTIONS:-}" == "true" || "${CI:-}" == "true" ]]
}

release_artifact_sync_can_commit_locally() {
  [[ "${local_signed_sync_requested:-false}" == "true" ]] && ! is_ci_environment
}

release_artifact_sync_mode() {
  if is_ci_environment; then
    echo "github-verified-api"
    return 0
  fi
  if release_artifact_sync_can_commit_locally; then
    echo "local-signed"
    return 0
  fi
  echo "manual-local-signed-required"
}

render_local_signed_sync_instructions() {
  local branch="$1"
  cat <<EOF
sync-release-pr-generated: generated release artifacts changed outside GitHub Actions.
sync-release-pr-generated: leave the release PR draft and run the local signed sync fallback from a clean checkout:
sync-release-pr-generated:   git fetch origin
sync-release-pr-generated:   bash scripts/sync-release-pr-generated.sh --local-signed-sync ${branch}
sync-release-pr-generated: The local path uses normal existing git commit signing configuration only.
sync-release-pr-generated: It does not import signing material, set signing config, or use CI-held signing secrets.
EOF
}

run_signed_sync_mode_self_test() {
  local local_signed_sync_requested=false
  local old_github_actions="${GITHUB_ACTIONS-}"
  local old_ci="${CI-}"
  unset GITHUB_ACTIONS CI

  if release_artifact_sync_can_commit_locally; then
    echo "sync-release-pr-generated self-test: FAIL (default mode must not create local sync commits)" >&2
    exit 1
  fi
  if [[ "$(release_artifact_sync_mode)" != "manual-local-signed-required" ]]; then
    echo "sync-release-pr-generated self-test: FAIL (default non-CI mode must require explicit local signed fallback)" >&2
    exit 1
  fi

  local_signed_sync_requested=true
  if ! release_artifact_sync_can_commit_locally; then
    echo "sync-release-pr-generated self-test: FAIL (explicit local mode should allow local sync commits outside CI)" >&2
    exit 1
  fi
  if [[ "$(release_artifact_sync_mode)" != "local-signed" ]]; then
    echo "sync-release-pr-generated self-test: FAIL (explicit local mode should select local signed fallback outside CI)" >&2
    exit 1
  fi

  GITHUB_ACTIONS=true
  if release_artifact_sync_can_commit_locally; then
    echo "sync-release-pr-generated self-test: FAIL (GitHub Actions must never use local sync commits)" >&2
    exit 1
  fi
  if [[ "$(release_artifact_sync_mode)" != "github-verified-api" ]]; then
    echo "sync-release-pr-generated self-test: FAIL (GitHub Actions must select createCommitOnBranch sync mode)" >&2
    exit 1
  fi
  local_signed_sync_requested=true
  if [[ "$(release_artifact_sync_mode)" != "github-verified-api" ]]; then
    echo "sync-release-pr-generated self-test: FAIL (GitHub Actions must not fall back to local signing when local mode is requested)" >&2
    exit 1
  fi
  local_signed_sync_requested=false
  unset GITHUB_ACTIONS
  if [[ -n "${old_github_actions}" ]]; then
    GITHUB_ACTIONS="${old_github_actions}"
  fi
  if [[ -n "${old_ci}" ]]; then
    CI="${old_ci}"
  fi

  local instructions
  instructions="$(render_local_signed_sync_instructions "release-please--branches--premain")"
  if [[ "${instructions}" != *"--local-signed-sync release-please--branches--premain"* ]]; then
    echo "sync-release-pr-generated self-test: FAIL (pending-sync instructions must name local signed sync command)" >&2
    exit 1
  fi
  local forbidden_private_key="PRIVATE""_KEY"
  if [[ "${instructions}" == *"${forbidden_private_key}"* ]]; then
    echo "sync-release-pr-generated self-test: FAIL (pending-sync instructions must not mention private signing secrets)" >&2
    exit 1
  fi

  echo "sync-release-pr-generated self-test: PASS signed-sync-mode"
}

run_sync_secret_material_self_test() {
  local script_text
  script_text="$(cat scripts/sync-release-pr-generated.sh)"

  local forbidden_private_key="PRIVATE""_KEY"
  local forbidden_release_sync_gpg="RELEASE_ARTIFACT_SYNC_""GPG"
  local forbidden_gpg_import="gpg ""--import"
  local forbidden_signing_key="git config user.""signingkey"
  local forbidden_gpg_program="git config gpg.""program"
  local forbidden_commit_signing="git config commit.""gpgsign true"
  local forbidden_commit_dash_s="git commit ""-S"

  for forbidden in \
    "${forbidden_private_key}" \
    "${forbidden_release_sync_gpg}" \
    "${forbidden_gpg_import}" \
    "${forbidden_signing_key}" \
    "${forbidden_gpg_program}" \
    "${forbidden_commit_signing}" \
    "${forbidden_commit_dash_s}"
  do
    if [[ "${script_text}" == *"${forbidden}"* ]]; then
      echo "sync-release-pr-generated self-test: FAIL (script contains forbidden signing material/config pattern)" >&2
      exit 1
    fi
  done

  if [[ "${script_text}" != *"createCommitOnBranch"* ]]; then
    echo "sync-release-pr-generated self-test: FAIL (CI artifact sync must use createCommitOnBranch)" >&2
    exit 1
  fi
  if [[ "${script_text}" != *"github-verified-api"* ]]; then
    echo "sync-release-pr-generated self-test: FAIL (CI artifact sync mode must be named github-verified-api)" >&2
    exit 1
  fi

  echo "sync-release-pr-generated self-test: PASS signing-material-policy"
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_required_check_classifier_self_test
  run_signed_sync_mode_self_test
  run_sync_secret_material_self_test
  exit 0
fi

local_signed_sync_requested=false
print_plan_requested=false
while [[ "${1:-}" == --* ]]; do
  case "${1:-}" in
    --local-signed-sync)
      local_signed_sync_requested=true
      shift
      ;;
    --print-plan)
      print_plan_requested=true
      shift
      ;;
    --help|-h)
      cat <<'USAGE'
usage: scripts/sync-release-pr-generated.sh [--print-plan] [--local-signed-sync] <release-branch>|--self-test

--print-plan prints the non-mutating GitHub API commit plan after regenerating
release artifacts. It does not send createCommitOnBranch or push.
USAGE
      exit 0
      ;;
    *)
      break
      ;;
  esac
done

release_branch="${1:-}"
if [[ -z "${release_branch}" ]]; then
  echo "sync-release-pr-generated: FAIL (usage: $0 [--print-plan] [--local-signed-sync] <release-branch>|--self-test)" >&2
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

required_checks_passed=false
synced_head=""

exit_if_benign_merged_release_pr() {
  local context="$1"
  local current_pr_line="${2:-}"
  if [[ -z "${current_pr_line}" ]]; then
    current_pr_line="$(pr_state_line)"
  fi
  if [[ -z "${current_pr_line}" ]]; then
    return 1
  fi

  local current_pr_state
  local current_pr_head
  current_pr_state="${current_pr_line%%$'\t'*}"
  current_pr_head="${current_pr_line##*$'\t'}"

  if [[ "${current_pr_state}" != "MERGED" ]]; then
    return 1
  fi

  if [[ "${required_checks_passed}" != "true" || -z "${synced_head}" ]]; then
    return 1
  fi

  if [[ "${current_pr_head}" != "${synced_head}" ]]; then
    echo "sync-release-pr-generated: FAIL (PR #${pr_number} merged ${context}; expected head ${synced_head}, found ${current_pr_head})"
    exit 1
  fi

  echo "sync-release-pr-generated: PASS (${release_branch} already merged after generated artifacts and required checks matched ${synced_head})"
  exit 0
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
    exit_if_benign_merged_release_pr "${context}" "${current_pr_line}" || true
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

  if [[ "${current_pr_state}" != "OPEN" && "${current_pr_state}" != "MERGED" ]]; then
    echo "sync-release-pr-generated: FAIL (PR #${pr_number} is ${current_pr_state} while reading checks)" >&2
    return 1
  fi
  if [[ "${current_pr_state}" == "MERGED" ]]; then
    echo "sync-release-pr-generated: PR #${pr_number} merged while reading checks; verifying required checks on ${current_pr_head}" >&2
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
      workflow: (.app.slug // "github-actions"),
      headSha: "'${current_pr_head}'"
    }]' >"${commit_checks_file}" 2>/dev/null; then
    printf '[]' >"${commit_checks_file}"
  fi

  CURRENT_PR_HEAD="${current_pr_head}" COMMIT_CHECKS_JSON="$(cat "${commit_checks_file}")" \
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


current_head = os.environ["CURRENT_PR_HEAD"]
records = []
for item in load("COMMIT_CHECKS_JSON"):
    if item.get("headSha") == current_head:
        records.append(item)

print(json.dumps(records, separators=(",", ":")))
PY

  rm -f "${commit_checks_file}"
}

wait_for_required_checks() {
  local timeout_seconds="${RELEASE_PR_CHECK_TIMEOUT_SECONDS:-2400}"
  local interval_seconds="${RELEASE_PR_CHECK_INTERVAL_SECONDS:-15}"
  local required_checks
  required_checks="$(release_pr_required_checks)"

  local deadline=$((SECONDS + timeout_seconds))

  while true; do
    local checks_json
    checks_json="$(collect_check_records)"

    local status_file
    status_file="$(mktemp)"
    CHECKS_JSON="${checks_json}" REQUIRED_CHECKS="${required_checks}" classify_required_checks >"${status_file}"

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
  local required_checks
  required_checks="$(release_pr_required_checks)"

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
  local dispatch_args=(workflow run "${required_check_workflow}" --ref "${release_branch}")

  if [[ "${required_check_workflow}" == "ci.yml" ]]; then
    dispatch_args+=(--raw-field run_full_rubric=false)
  fi

  echo "sync-release-pr-generated: dispatching ${required_check_workflow} for ${release_branch} with full rubric disabled"
  if ! gh "${dispatch_args[@]}"; then
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
      exit_if_benign_merged_release_pr "before head ${expected_head} was visible" "${current_pr_line}" || true
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

require_pr_head() {
  local expected_head="$1"
  local context="$2"
  local current_pr_line
  current_pr_line="$(pr_state_line)"
  if [[ -z "${current_pr_line}" ]]; then
    echo "sync-release-pr-generated: FAIL (PR #${pr_number} disappeared ${context})"
    exit 1
  fi

  local current_pr_state
  local current_pr_head
  current_pr_state="${current_pr_line%%$'\t'*}"
  current_pr_head="${current_pr_line##*$'\t'}"

  if [[ "${current_pr_state}" != "OPEN" ]]; then
    exit_if_benign_merged_release_pr "${context}" "${current_pr_line}" || true
    echo "sync-release-pr-generated: FAIL (PR #${pr_number} is ${current_pr_state} ${context})"
    exit 1
  fi

  if [[ "${current_pr_head}" != "${expected_head}" ]]; then
    echo "sync-release-pr-generated: FAIL (PR #${pr_number} head changed ${context}; expected ${expected_head}, found ${current_pr_head})"
    exit 1
  fi
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

require_clean_worktree() {
  local status
  status="$(git status --porcelain=v1 --untracked-files=all)"
  if [[ -n "${status}" ]]; then
    echo "sync-release-pr-generated: FAIL (working tree must be clean before release PR artifact sync)" >&2
    echo "${status}" >&2
    exit 1
  fi
}

require_only_release_artifact_changes() {
  python3 - <<'PY'
import subprocess
import sys

allowed_exact = {".release-please-manifest.premain.json", "cdk/.jsii"}
allowed_prefixes = ("cdk/lib/", "cdk-go/apptheorycdk/")

raw = subprocess.check_output(
    ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
)
records = [record for record in raw.decode("utf-8", "surrogateescape").split("\0") if record]
unexpected: list[str] = []
for record in records:
    if len(record) < 4:
        continue
    path = record[3:]
    if " -> " in path:
        path = path.split(" -> ", 1)[1]
    if path in allowed_exact or path.startswith(allowed_prefixes):
        continue
    unexpected.append(path)

if unexpected:
    print("sync-release-pr-generated: FAIL (artifact sync produced changes outside the release artifact allowlist)", file=sys.stderr)
    for path in unexpected:
        print(f"  {path}", file=sys.stderr)
    sys.exit(1)
PY
}

build_release_artifact_sync_commit_payload() {
  local branch="$1"
  local expected_head="$2"
  local repo="$3"
  local payload_file="$4"
  local summary_file="$5"

  RELEASE_BRANCH="${branch}" \
    EXPECTED_HEAD_OID="${expected_head}" \
    REPOSITORY_NAME_WITH_OWNER="${repo}" \
    ARTIFACT_SYNC_COMMIT_MESSAGE="${artifact_sync_commit_message}" \
    PAYLOAD_FILE="${payload_file}" \
    SUMMARY_FILE="${summary_file}" \
    python3 - <<'PY'
import base64
import json
import os
import subprocess
import sys
from pathlib import Path

PATHS = [
    ".release-please-manifest.premain.json",
    "cdk/.jsii",
    "cdk/lib",
    "cdk-go/apptheorycdk",
]


def zlines(args: list[str]) -> list[str]:
    raw = subprocess.check_output(args)
    return [item for item in raw.decode("utf-8", "surrogateescape").split("\0") if item]


tracked_additions = zlines(["git", "diff", "--name-only", "-z", "--diff-filter=ACMRT", "HEAD", "--", *PATHS])
tracked_deletions = zlines(["git", "diff", "--name-only", "-z", "--diff-filter=D", "HEAD", "--", *PATHS])
untracked_additions = zlines(["git", "ls-files", "--others", "--exclude-standard", "-z", "--", *PATHS])

addition_paths = sorted(set(tracked_additions + untracked_additions))
deletion_paths = sorted(set(tracked_deletions) - set(addition_paths))

additions = []
for path in addition_paths:
    file_path = Path(path)
    if not file_path.is_file():
        print(f"sync-release-pr-generated: FAIL (planned addition is not a file: {path})", file=sys.stderr)
        sys.exit(1)
    additions.append(
        {
            "path": path,
            "contents": base64.b64encode(file_path.read_bytes()).decode("ascii"),
        }
    )

deletions = [{"path": path} for path in deletion_paths]

summary = {
    "mode": os.environ.get("ARTIFACT_SYNC_MODE", ""),
    "branch": os.environ["RELEASE_BRANCH"],
    "expectedHeadOid": os.environ["EXPECTED_HEAD_OID"],
    "message": os.environ["ARTIFACT_SYNC_COMMIT_MESSAGE"],
    "additionCount": len(additions),
    "deletionCount": len(deletions),
    "additions": addition_paths,
    "deletions": deletion_paths,
}

payload = {
    "query": """
mutation CreateReleaseArtifactSyncCommit($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit {
      oid
      url
    }
  }
}
""",
    "variables": {
        "input": {
            "branch": {
                "repositoryNameWithOwner": os.environ["REPOSITORY_NAME_WITH_OWNER"],
                "branchName": os.environ["RELEASE_BRANCH"],
            },
            "message": {
                "headline": os.environ["ARTIFACT_SYNC_COMMIT_MESSAGE"],
            },
            "fileChanges": {
                "additions": additions,
                "deletions": deletions,
            },
            "expectedHeadOid": os.environ["EXPECTED_HEAD_OID"],
        },
    },
}

Path(os.environ["PAYLOAD_FILE"]).write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
Path(os.environ["SUMMARY_FILE"]).write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

print_release_artifact_sync_plan() {
  local expected_head="$1"
  local repo="$2"
  local mode="$3"

  local payload_file
  local summary_file
  payload_file="$(mktemp)"
  summary_file="$(mktemp)"
  ARTIFACT_SYNC_MODE="${mode}" build_release_artifact_sync_commit_payload \
    "${release_branch}" \
    "${expected_head}" \
    "${repo}" \
    "${payload_file}" \
    "${summary_file}"

  cat "${summary_file}"
  rm -f "${payload_file}" "${summary_file}"
}

verify_github_verified_commit() {
  local sha="$1"
  local context="$2"
  local repo="$3"

  local verification
  if ! verification="$(
    gh api "repos/${repo}/commits/${sha}" \
      --jq '[.commit.verification.verified, .commit.verification.reason, (.commit.verification.signer.login // ""), (.commit.verification.key_id // "")] | @tsv'
  )"; then
    echo "sync-release-pr-generated: FAIL (${context} GitHub verification evidence unavailable for ${sha})" >&2
    exit 1
  fi

  local verified reason signer key
  IFS=$'\t' read -r verified reason signer key <<<"${verification}"
  if [[ "${verified}" != "true" || "${reason}" != "valid" ]]; then
    echo "sync-release-pr-generated: FAIL (${context} is not GitHub verified-valid; verified=${verified:-unknown} reason=${reason:-unknown})" >&2
    exit 1
  fi

  echo "sync-release-pr-generated: ${context} GitHub verification verified=${verified} reason=${reason} signer=${signer:-unknown} key=${key:-unknown}"
}

verify_github_synced_head() {
  local expected_head="$1"
  local new_head="$2"
  local repo="$3"

  git fetch origin "${release_branch}"
  local fetched_head
  fetched_head="$(git rev-parse FETCH_HEAD)"
  if [[ "${fetched_head}" != "${new_head}" ]]; then
    echo "sync-release-pr-generated: FAIL (${release_branch} fetched head ${fetched_head} does not match created commit ${new_head})" >&2
    exit 1
  fi

  verify_github_verified_commit "${new_head}" "generated release-artifact sync" "${repo}"
  scripts/verify-release-branch-signatures.sh \
    --range "${expected_head}..${new_head}" \
    --label "release-artifact-sync:${release_branch}"
}

commit_release_artifact_sync_via_github() {
  local expected_head="$1"
  local repo="$2"

  if [[ -n "${GITHUB_TOKEN:-}" && -z "${GH_TOKEN:-}" ]]; then
    export GH_TOKEN="${GITHUB_TOKEN}"
  fi

  local payload_file
  local summary_file
  local response_file
  payload_file="$(mktemp)"
  summary_file="$(mktemp)"
  response_file="$(mktemp)"

  ARTIFACT_SYNC_MODE="github-verified-api" build_release_artifact_sync_commit_payload \
    "${release_branch}" \
    "${expected_head}" \
    "${repo}" \
    "${payload_file}" \
    "${summary_file}"

  local addition_count
  local deletion_count
  addition_count="$(python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); print(data["additionCount"])' "${summary_file}")"
  deletion_count="$(python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); print(data["deletionCount"])' "${summary_file}")"
  if [[ "${addition_count}" == "0" && "${deletion_count}" == "0" ]]; then
    echo "sync-release-pr-generated: FAIL (generated artifacts changed, but the GitHub commit plan is empty)" >&2
    rm -f "${payload_file}" "${summary_file}" "${response_file}"
    exit 1
  fi

  echo "sync-release-pr-generated: creating GitHub-verified generated release-artifact sync commit on ${release_branch}" >&2
  echo "sync-release-pr-generated: plan addition_count=${addition_count} deletion_count=${deletion_count} expected_head=${expected_head}" >&2

  if ! gh api graphql --input "${payload_file}" --jq '.data.createCommitOnBranch.commit.oid' >"${response_file}"; then
    rm -f "${payload_file}" "${summary_file}" "${response_file}"
    echo "sync-release-pr-generated: FAIL (createCommitOnBranch generated artifact sync mutation failed)" >&2
    exit 1
  fi

  local new_head
  new_head="$(cat "${response_file}")"
  rm -f "${payload_file}" "${summary_file}" "${response_file}"

  if [[ -z "${new_head}" || "${new_head}" == "null" ]]; then
    echo "sync-release-pr-generated: FAIL (createCommitOnBranch did not return a commit oid)" >&2
    exit 1
  fi

  echo "${new_head}"
}

require_existing_local_signing_config() {
  local commit_gpgsign
  commit_gpgsign="$(git config --bool --get commit.gpgsign || true)"
  if [[ "${commit_gpgsign}" != "true" ]]; then
    echo "sync-release-pr-generated: FAIL (local signed sync requires existing git commit signing config; commit.gpgsign is not true)" >&2
    echo "sync-release-pr-generated: refusing to create a generated release-artifact sync commit that may be unsigned" >&2
    exit 1
  fi
}

verify_head_locally_signed() {
  local context="$1"

  if ! git verify-commit HEAD; then
    echo "sync-release-pr-generated: FAIL (${context} commit signature did not verify locally)" >&2
    echo "sync-release-pr-generated: do not push this commit; fix local signing configuration and recreate the sync commit" >&2
    exit 1
  fi

  local signature_status
  local signature_signer
  local signature_key
  signature_status="$(git log -1 --format=%G? HEAD)"
  signature_signer="$(git log -1 --format=%GS HEAD)"
  signature_key="$(git log -1 --format=%GK HEAD)"

  echo "sync-release-pr-generated: ${context} signature status=${signature_status} signer=${signature_signer:-unknown} key=${signature_key:-unknown}"

  if [[ "${signature_status}" != "G" ]]; then
    echo "sync-release-pr-generated: FAIL (${context} commit signature is not locally trusted-good; status=${signature_status})" >&2
    echo "sync-release-pr-generated: do not push this commit; fix local signing configuration and recreate the sync commit" >&2
    exit 1
  fi
}

commit_release_artifact_sync_locally() {
  require_existing_local_signing_config
  git add .release-please-manifest.premain.json cdk/.jsii cdk/lib cdk-go/apptheorycdk
  if ! git commit -m "${artifact_sync_commit_message}"; then
    echo "sync-release-pr-generated: FAIL (normal local git commit failed; no CI signing fallback exists)" >&2
    exit 1
  fi
  verify_head_locally_signed "generated release-artifact sync"
}

push_local_signed_release_artifact_sync() {
  git push origin HEAD:"${release_branch}"
}

# The release PR must not be mergeable while generated artifacts are still being
# rewritten. This is the release-lane invariant: release-please version files and
# generated CDK/jsii artifacts land in the same release PR before it becomes
# ready for review.
require_clean_worktree
ensure_release_pr_is_draft "before generated artifacts are synced"

git fetch origin "${release_branch}"
expected_head="$(git rev-parse FETCH_HEAD)"
git switch --detach "${expected_head}"
require_pr_head "${expected_head}" "after fetching release branch"

sync_stable_release_premain_manifest
scripts/update-cdk-generated.sh >/dev/null

changed=false
artifact_status="$(git status --porcelain=v1 --untracked-files=all -- .release-please-manifest.premain.json cdk/.jsii cdk/lib cdk-go/apptheorycdk)"
if [[ -n "${artifact_status}" ]]; then
  changed=true
  require_only_release_artifact_changes
fi

repo="$(repo_full_name)"
sync_mode="$(release_artifact_sync_mode)"

if [[ "${print_plan_requested}" == "true" ]]; then
  print_release_artifact_sync_plan "${expected_head}" "${repo}" "${sync_mode}"
  exit 0
fi

go test ./cdk-go/apptheorycdk

if [[ "${changed}" == "true" ]]; then
  case "${sync_mode}" in
    local-signed)
      commit_release_artifact_sync_locally
      synced_head="$(git rev-parse HEAD)"
      ensure_release_pr_is_draft "before generated artifacts are pushed"
      push_local_signed_release_artifact_sync
      ;;
    github-verified-api)
      ensure_release_pr_is_draft "before creating GitHub-verified generated artifact sync commit"
      require_pr_head "${expected_head}" "before creating GitHub-verified generated artifact sync commit"
      synced_head="$(commit_release_artifact_sync_via_github "${expected_head}" "${repo}")"
      verify_github_synced_head "${expected_head}" "${synced_head}" "${repo}"
      ;;
    *)
      render_local_signed_sync_instructions "${release_branch}" >&2
      exit 1
      ;;
  esac
else
  synced_head="${expected_head}"
fi

wait_for_pr_head "${synced_head}"
# After the generated-artifact head is visible, rely only on independent PR
# checks for protected required contexts. Bot-authored release PR updates can be
# suppressed by GitHub's recursive workflow guard, so explicitly dispatch CI on
# the release branch instead of self-attesting protected statuses from mutable
# release-branch code.
ensure_release_pr_is_draft "before waiting for independent required checks"
require_pr_head "${synced_head}" "before dispatching independent required checks"
dispatch_required_checks
wait_for_required_checks_to_start
wait_for_required_checks
required_checks_passed=true

require_pr_head "${synced_head}" "after required checks passed"
ensure_release_pr_is_draft "before marking generated-artifact-synced PR ready"
require_pr_head "${synced_head}" "before marking generated-artifact-synced PR ready"
if ! gh pr ready "${pr_number}"; then
  exit_if_benign_merged_release_pr "while marking generated-artifact-synced PR ready" || true
  echo "sync-release-pr-generated: FAIL (PR #${pr_number} could not be marked ready after generated artifacts and required checks matched ${synced_head})"
  exit 1
fi

current_pr_line="$(pr_state_line)"
if [[ -z "${current_pr_line}" ]]; then
  echo "sync-release-pr-generated: FAIL (PR #${pr_number} disappeared after marking ready)"
  exit 1
fi
current_pr_state="${current_pr_line%%$'\t'*}"
current_pr_is_draft="${current_pr_line#*$'\t'}"
current_pr_is_draft="${current_pr_is_draft%%$'\t'*}"
current_pr_head="${current_pr_line##*$'\t'}"
if [[ "${current_pr_state}" != "OPEN" ]]; then
  exit_if_benign_merged_release_pr "after marking ready" "${current_pr_line}" || true
  echo "sync-release-pr-generated: FAIL (PR #${pr_number} is ${current_pr_state} after marking ready)"
  exit 1
fi
if [[ "${current_pr_head}" != "${synced_head}" ]]; then
  gh pr ready "${pr_number}" --undo || true
  echo "sync-release-pr-generated: FAIL (PR #${pr_number} head changed while marking ready; expected ${synced_head}, found ${current_pr_head})"
  exit 1
fi
if [[ "${current_pr_is_draft}" != "false" ]]; then
  echo "sync-release-pr-generated: FAIL (PR #${pr_number} could not be marked ready after generated artifacts and required checks matched ${synced_head})"
  exit 1
fi

echo "sync-release-pr-generated: PASS (${release_branch} updated)"
