#!/usr/bin/env bash
# Purpose: synchronize generated artifacts on release-please PR branches.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

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

if [[ "${1:-}" == "--self-test" ]]; then
  run_required_check_classifier_self_test
  exit 0
fi

release_branch="${1:-}"
if [[ -z "${release_branch}" ]]; then
  echo "sync-release-pr-generated: FAIL (usage: $0 <release-branch>|--self-test)" >&2
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

configure_release_artifact_sync_signing() {
  if ! command -v gpg >/dev/null 2>&1; then
    echo "sync-release-pr-generated: FAIL (gpg not found; generated release-artifact sync commits must be signed)"
    exit 1
  fi

  if [[ -z "${RELEASE_ARTIFACT_SYNC_GPG_PRIVATE_KEY:-}" ]]; then
    echo "sync-release-pr-generated: FAIL (RELEASE_ARTIFACT_SYNC_GPG_PRIVATE_KEY is required to sign generated release-artifact sync commits)"
    exit 1
  fi

  local gpg_home
  gpg_home="$(mktemp -d)"
  chmod 700 "${gpg_home}"
  export GNUPGHOME="${gpg_home}"
  trap 'rm -rf "${GNUPGHOME:-}"' EXIT

  local key_file
  key_file="$(mktemp)"
  if grep -Fq "BEGIN PGP PRIVATE KEY BLOCK" <<<"${RELEASE_ARTIFACT_SYNC_GPG_PRIVATE_KEY}"; then
    printf '%s\n' "${RELEASE_ARTIFACT_SYNC_GPG_PRIVATE_KEY}" >"${key_file}"
  elif ! printf '%s' "${RELEASE_ARTIFACT_SYNC_GPG_PRIVATE_KEY}" | base64 --decode >"${key_file}" 2>/dev/null; then
    rm -f "${key_file}"
    echo "sync-release-pr-generated: FAIL (release-artifact signing key must be armored or base64-encoded GPG private key)"
    exit 1
  fi

  if ! gpg --batch --import "${key_file}" >/dev/null 2>&1; then
    rm -f "${key_file}"
    echo "sync-release-pr-generated: FAIL (could not import release-artifact signing key)"
    exit 1
  fi
  rm -f "${key_file}"

  local key_id
  key_id="${RELEASE_ARTIFACT_SYNC_GPG_KEY_ID:-}"
  if [[ -z "${key_id}" ]]; then
    key_id="$(
      gpg --batch --list-secret-keys --with-colons --fingerprint \
        | awk -F: '$1 == "fpr" { print $10; exit }'
    )"
  fi
  if [[ -z "${key_id}" ]]; then
    echo "sync-release-pr-generated: FAIL (could not determine release-artifact signing key id)"
    exit 1
  fi

  if [[ -n "${RELEASE_ARTIFACT_SYNC_GPG_PASSPHRASE:-}" ]]; then
    local gpg_wrapper
    gpg_wrapper="${gpg_home}/gpg-wrapper"
    cat >"${gpg_wrapper}" <<'EOF'
#!/usr/bin/env bash
exec gpg --batch --yes --pinentry-mode loopback --passphrase "${RELEASE_ARTIFACT_SYNC_GPG_PASSPHRASE}" "$@"
EOF
    chmod 700 "${gpg_wrapper}"
    git config gpg.program "${gpg_wrapper}"
  else
    git config gpg.program gpg
  fi

  git config commit.gpgsign true
  git config user.signingkey "${key_id}"
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
  configure_release_artifact_sync_signing
  git add .release-please-manifest.premain.json cdk/.jsii cdk/lib cdk-go/apptheorycdk
  git commit -S -m "chore(release): sync generated release artifacts"
  git verify-commit HEAD
fi

go test ./cdk-go/apptheorycdk

ensure_release_pr_is_draft "before generated artifacts are pushed"

if [[ "${changed}" == "true" ]]; then
  git push origin HEAD:"${release_branch}"
fi

synced_head="$(git rev-parse HEAD)"

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
