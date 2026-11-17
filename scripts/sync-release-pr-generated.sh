#!/usr/bin/env bash
# Purpose: synchronize generated artifacts on release-please PR branches.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

artifact_sync_commit_message="fix(release): sync generated release artifacts"
artifact_sync_commit_body="[skip ci]"

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
  local plan_text
  script_text="$(cat scripts/sync-release-pr-generated.sh)"
  plan_text="$(cat scripts/render-release-artifact-sync-plan.py)"

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
    if [[ "${script_text}${plan_text}" == *"${forbidden}"* ]]; then
      echo "sync-release-pr-generated self-test: FAIL (script contains forbidden signing material/config pattern)" >&2
      exit 1
    fi
  done

  if [[ "${plan_text}" != *"createCommitOnBranch"* ]]; then
    echo "sync-release-pr-generated self-test: FAIL (CI artifact sync must use createCommitOnBranch)" >&2
    exit 1
  fi
  if [[ "${script_text}" != *"github-verified-api"* ]]; then
    echo "sync-release-pr-generated self-test: FAIL (CI artifact sync mode must be named github-verified-api)" >&2
    exit 1
  fi

  echo "sync-release-pr-generated self-test: PASS signing-material-policy"
}

run_artifact_plan_self_test() {
  local repo_root
  local fixture_dir
  local baseline_root
  local worktree_root
  local payload_file
  local summary_file
  repo_root="${PWD}"
  fixture_dir="$(mktemp -d)"
  baseline_root="${fixture_dir}/baseline"
  worktree_root="${fixture_dir}/worktree"
  payload_file="${fixture_dir}/payload.json"
  summary_file="${fixture_dir}/summary.json"

  mkdir -p \
    "${baseline_root}/cdk-go" \
    "${worktree_root}/cdk-go/apptheorycdk"
  printf '%s\n' "module github.com/theory-cloud/apptheory/cdk-go" >"${baseline_root}/cdk-go/go.mod"
  printf '%s\n' "legacy sum" >"${baseline_root}/cdk-go/go.sum"
  printf '%s\n' "module github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v7" \
    >"${worktree_root}/cdk-go/apptheorycdk/go.mod"
  printf '%s\n' "canonical sum" >"${worktree_root}/cdk-go/apptheorycdk/go.sum"

  (
    cd "${worktree_root}"
    python3 "${repo_root}/scripts/render-release-artifact-sync-plan.py" \
      --branch release-please--branches--premain \
      --expected-head 0000000000000000000000000000000000000000 \
      --repository theory-cloud/AppTheory \
      --message "${artifact_sync_commit_message}" \
      --body "${artifact_sync_commit_body}" \
      --mode self-test \
      --payload-file "${payload_file}" \
      --summary-file "${summary_file}" \
      --baseline-root "${baseline_root}"
  )

  python3 - "${summary_file}" <<'PY'
import json
import sys
from pathlib import Path

summary = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if summary.get("additionCount") != 2 or summary.get("deletionCount") != 2:
    raise SystemExit(
        "sync-release-pr-generated self-test: FAIL "
        f"(major-version plan counts: {summary.get('additionCount')}/{summary.get('deletionCount')})"
    )
PY
  rm -rf "${fixture_dir}"
  echo "sync-release-pr-generated self-test: PASS major-version-artifact-plan"
}

# Classify a failed gh read instead of collapsing every failure into "the PR
# disappeared". Authentication failures, genuine not-found responses and
# transient transport failures are distinct states; only notfound may ever be
# reported as absent, and even then it never authorizes readiness.
classify_gh_failure() {
  local status="$1"
  local text="$2"
  if [[ "${status}" == "4" ]] || grep -Eqi 'authentication|not logged|bad credentials|HTTP 40[13]|GH_TOKEN|gh auth login' <<<"${text}"; then
    echo auth
    return 0
  fi
  if grep -Eqi 'Could not resolve to a (PullRequest|Repository)|not found|HTTP 404|No pull requests found' <<<"${text}"; then
    echo notfound
    return 0
  fi
  if grep -Eqi 'HTTP 5[0-9][0-9]|timeout|timed out|connection reset|connection refused|temporary failure|rate limit|secondary rate|TLS' <<<"${text}"; then
    echo transient
    return 0
  fi
  echo error
}

read_pr_state() {
  local attempt=1
  while true; do
    local stderr_file
    local out
    local status=0
    stderr_file="$(mktemp)"
    out="$(gh pr view "${pr_number}" --json state,isDraft,headRefOid --jq '"\(.state)\t\(.isDraft)\t\(.headRefOid)"' 2>"${stderr_file}")" || status=$?
    local stderr_text
    stderr_text="$(cat "${stderr_file}")"
    rm -f "${stderr_file}"
    if (( status == 0 )) && [[ -n "${out}" ]]; then
      PR_STATE_KIND=ok
      PR_STATE_LINE="${out}"
      PR_FAILURE_DETAIL=""
      return 0
    fi

    local kind
    kind="$(classify_gh_failure "${status}" "${stderr_text}")"
    if [[ "${kind}" == "transient" ]] && (( attempt < PR_READ_ATTEMPTS )); then
      sleep "$(( attempt * PR_READ_BACKOFF_SECONDS ))"
      attempt=$((attempt + 1))
      continue
    fi
    PR_STATE_KIND="${kind}"
    PR_STATE_LINE=""
    PR_FAILURE_DETAIL="gh pr view #${pr_number} exited ${status}: ${stderr_text:-empty output}"
    return 1
  done
}

fail_pr_read() {
  local context="$1"
  case "${PR_STATE_KIND}" in
    notfound)
      echo "sync-release-pr-generated: FAIL (PR #${pr_number} not found ${context}; a failed lookup is never read as disappeared or merged)" >&2
      ;;
    auth)
      echo "sync-release-pr-generated: FAIL (PR #${pr_number} read denied by credentials ${context}; ${PR_FAILURE_DETAIL})" >&2
      ;;
    transient)
      echo "sync-release-pr-generated: FAIL (PR #${pr_number} read unavailable after ${PR_READ_ATTEMPTS} attempts ${context}; ${PR_FAILURE_DETAIL})" >&2
      ;;
    *)
      echo "sync-release-pr-generated: FAIL (PR #${pr_number} read failed ${context}; ${PR_FAILURE_DETAIL})" >&2
      ;;
  esac
  exit 1
}

require_pr_state_line() {
  local context="$1"
  if ! read_pr_state; then
    fail_pr_read "${context}"
  fi
  printf '%s\n' "${PR_STATE_LINE}"
}

synced_head=""

exit_if_benign_merged_release_pr() {
  local context="$1"
  local current_pr_line="${2:-}"
  if [[ -z "${current_pr_line}" ]]; then
    read_pr_state || return 1
    current_pr_line="${PR_STATE_LINE}"
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

  if [[ -z "${synced_head}" ]]; then
    return 1
  fi

  if [[ "${current_pr_head}" != "${synced_head}" ]]; then
    echo "sync-release-pr-generated: FAIL (PR #${pr_number} merged ${context}; expected head ${synced_head}, found ${current_pr_head})"
    exit 1
  fi

  echo "sync-release-pr-generated: PASS (${release_branch} already merged at the generated-artifact head ${synced_head})"
  exit 0
}

ensure_release_pr_is_draft() {
  local context="$1"
  local current_pr_line
  current_pr_line="$(require_pr_state_line "${context}")"

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

    current_pr_line="$(require_pr_state_line "${context} after drafting")"
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


wait_for_pr_head() {
  local expected_head="$1"
  local timeout_seconds="${RELEASE_PR_HEAD_TIMEOUT_SECONDS:-300}"
  local interval_seconds="${RELEASE_PR_CHECK_INTERVAL_SECONDS:-15}"
  local deadline=$((SECONDS + timeout_seconds))

  while true; do
    local current_pr_line
    current_pr_line="$(require_pr_state_line "before head ${expected_head} was visible")"

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
  current_pr_line="$(require_pr_state_line "${context}")"

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

allowed_exact = {
    ".release-please-manifest.premain.json",
    "cdk/.jsii",
    "cdk-go/go.mod",
    "cdk-go/go.sum",
}
allowed_prefixes = ("cdk/lib/", "cdk-go/apptheorycdk/")

raw = subprocess.check_output(
    ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
)
records = [record for record in raw.decode("utf-8", "surrogateescape").split("\0") if record]
unexpected: list[str] = []
index = 0
while index < len(records):
    record = records[index]
    index += 1
    if len(record) < 4:
        continue
    status = record[:2]
    path = record[3:]
    paths = [path]
    if "R" in status or "C" in status:
        if index >= len(records):
            unexpected.append(f"{path} (missing rename/copy source)")
            continue
        paths.append(records[index])
        index += 1
    for candidate in paths:
        if candidate in allowed_exact or candidate.startswith(allowed_prefixes):
            continue
        unexpected.append(candidate)

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

  python3 scripts/render-release-artifact-sync-plan.py \
    --branch "${branch}" \
    --expected-head "${expected_head}" \
    --repository "${repo}" \
    --message "${artifact_sync_commit_message}" \
    --body "${artifact_sync_commit_body}" \
    --mode "${ARTIFACT_SYNC_MODE:-}" \
    --payload-file "${payload_file}" \
    --summary-file "${summary_file}"
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
  git add -A \
    .release-please-manifest.premain.json \
    cdk/.jsii \
    cdk/lib \
    cdk-go/go.mod \
    cdk-go/go.sum \
    cdk-go/apptheorycdk
  if ! git commit -m "${artifact_sync_commit_message}" -m "${artifact_sync_commit_body}"; then
    echo "sync-release-pr-generated: FAIL (normal local git commit failed; no CI signing fallback exists)" >&2
    exit 1
  fi
  verify_head_locally_signed "generated release-artifact sync"
}

push_local_signed_release_artifact_sync() {
  git push origin HEAD:"${release_branch}"
}


run_read_classifier_self_test() {
  local failures=0

  check_kind() {
    local label="$1"
    local status="$2"
    local text="$3"
    local want="$4"
    local got
    got="$(classify_gh_failure "${status}" "${text}")"
    if [[ "${got}" != "${want}" ]]; then
      echo "sync-release-pr-generated self-test: FAIL ${label} (expected ${want}, got ${got})" >&2
      failures=$((failures + 1))
    else
      echo "sync-release-pr-generated self-test: PASS ${label}"
    fi
  }

  check_kind "auth exit 4" "4" "gh auth not configured" "auth"
  check_kind "auth HTTP 401" "1" "gh: Bad credentials (HTTP 401)" "auth"
  check_kind "genuine 404" "1" "Could not resolve to a PullRequest with the number of 1275." "notfound"
  check_kind "transient 503" "1" "gh: Service Unavailable (HTTP 503)" "transient"
  check_kind "unclassified" "1" "something unexpected" "error"

  local transient_calls_file transient_sleeps_file
  transient_calls_file="$(mktemp)"
  transient_sleeps_file="$(mktemp)"
  (
    PR_READ_ATTEMPTS=4
    PR_READ_BACKOFF_SECONDS=2
    pr_number=1275
    gh() {
      local calls
      calls="$(wc -l <"${transient_calls_file}")"
      printf '%s\n' "$*" >>"${transient_calls_file}"
      if (( calls < 2 )); then
        echo "gh: Service Unavailable (HTTP 503)" >&2
        return 1
      fi
      printf 'OPEN\ttrue\tabc123\n'
    }
    sleep() {
      printf '%s\n' "$1" >>"${transient_sleeps_file}"
    }
    read_pr_state || exit 1
    [[ "${PR_STATE_KIND}" == "ok" && "${PR_STATE_LINE}" == $'OPEN\ttrue\tabc123' ]]
  ) || {
    echo "sync-release-pr-generated self-test: FAIL transient read did not recover" >&2
    failures=$((failures + 1))
  }
  if [[ "$(wc -l <"${transient_calls_file}")" -ne 3 || "$(tr '\n' ' ' <"${transient_sleeps_file}")" != "2 4 " ]]; then
    echo "sync-release-pr-generated self-test: FAIL transient read attempts/sleeps were not bounded as expected" >&2
    failures=$((failures + 1))
  else
    echo "sync-release-pr-generated self-test: PASS transient read is retried with bounded backoff"
  fi
  rm -f "${transient_calls_file}" "${transient_sleeps_file}"

  local auth_calls_file
  auth_calls_file="$(mktemp)"
  (
    PR_READ_ATTEMPTS=4
    pr_number=1275
    gh() {
      printf '%s\n' "$*" >>"${auth_calls_file}"
      echo "gh: authentication failed (HTTP 401)" >&2
      return 1
    }
    sleep() {
      echo "unexpected sleep" >&2
      exit 9
    }
    read_pr_state && exit 1
    [[ "${PR_STATE_KIND}" == "auth" ]]
  ) || {
    echo "sync-release-pr-generated self-test: FAIL auth failure was retried or misclassified" >&2
    failures=$((failures + 1))
  }
  if [[ "$(wc -l <"${auth_calls_file}")" -ne 1 ]]; then
    echo "sync-release-pr-generated self-test: FAIL auth failure was retried" >&2
    failures=$((failures + 1))
  else
    echo "sync-release-pr-generated self-test: PASS auth failure is permanent and classified"
  fi
  rm -f "${auth_calls_file}"

  echo "sync-release-pr-generated self-test: PASS read-classification"
}



if [[ "${1:-}" == "--self-test" ]]; then
  run_signed_sync_mode_self_test
  run_sync_secret_material_self_test
  run_artifact_plan_self_test
  run_read_classifier_self_test
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

PR_READ_ATTEMPTS="${RELEASE_PR_READ_ATTEMPTS:-4}"
PR_READ_BACKOFF_SECONDS="${RELEASE_PR_READ_BACKOFF_SECONDS:-2}"
PR_STATE_KIND=""
PR_STATE_LINE=""
PR_FAILURE_DETAIL=""

release_branch="${1:-}"
if [[ -z "${release_branch}" ]]; then
  echo "sync-release-pr-generated: FAIL (usage: $0 [--print-plan] [--local-signed-sync] <release-branch>|--self-test)" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "sync-release-pr-generated: FAIL (gh not found)" >&2
  exit 1
fi

# Resolve the open release PR with the same bounded-retry classification used
# for every later read. An empty result is only a skip after a successful read;
# a failed read is reported as the failure it is.
read_open_release_pr() {
  local attempt=1
  while true; do
    local stderr_file
    local out
    local status=0
    stderr_file="$(mktemp)"
    out="$(gh pr list --state open --head "${release_branch}" --json number,isDraft --jq '.[] | "\(.number)\t\(.isDraft)"' 2>"${stderr_file}")" || status=$?
    local stderr_text
    stderr_text="$(cat "${stderr_file}")"
    rm -f "${stderr_file}"
    if (( status == 0 )); then
      printf '%s\n' "${out}" | head -n 1
      return 0
    fi
    local kind
    kind="$(classify_gh_failure "${status}" "${stderr_text}")"
    if [[ "${kind}" == "transient" ]] && (( attempt < PR_READ_ATTEMPTS )); then
      sleep "$(( attempt * PR_READ_BACKOFF_SECONDS ))"
      attempt=$((attempt + 1))
      continue
    fi
    echo "sync-release-pr-generated: FAIL (could not list the open PR for ${release_branch} (${kind}); ${stderr_text:-empty output})" >&2
    return 1
  done
}

pr_line="$(read_open_release_pr)"
if [[ -z "${pr_line}" ]]; then
  echo "sync-release-pr-generated: SKIP (no open PR for ${release_branch})"
  exit 0
fi

pr_number="${pr_line%%$'\t'*}"
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
artifact_status="$(
  git status --porcelain=v1 --untracked-files=all -- \
    .release-please-manifest.premain.json \
    cdk/.jsii \
    cdk/lib \
    cdk-go/go.mod \
    cdk-go/go.sum \
    cdk-go/apptheorycdk
)"
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

bash scripts/verify-cdk-go.sh

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

echo "sync-release-pr-generated: PASS (${release_branch} updated)"
