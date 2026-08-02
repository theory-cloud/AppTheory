#!/usr/bin/env bash
# Purpose: fail closed when release/protected branch history contains unsigned commits.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SIGNED_HISTORY_BASE="${SIGNED_HISTORY_BASE:-c723c42c71d9220f49702db965d4deffff6183f1}"
HISTORICAL_UNSIGNED_FIXTURE="${HISTORICAL_UNSIGNED_FIXTURE:-ae2468e0c27b02138ad25f3035afff17e253b8a1}"
RELEASE_SIGNATURE_VERBOSE="${RELEASE_SIGNATURE_VERBOSE:-false}"
RELEASE_SIGNATURE_RETRY_SLEEP_BUDGET_SECONDS="${RELEASE_SIGNATURE_RETRY_SLEEP_BUDGET_SECONDS:-300}"

if [[ ! "${RELEASE_SIGNATURE_RETRY_SLEEP_BUDGET_SECONDS}" =~ ^[0-9]+$ ]]; then
  echo "release-signatures: FAIL RELEASE_SIGNATURE_RETRY_SLEEP_BUDGET_SECONDS must be a non-negative integer" >&2
  exit 1
fi

release_signature_retry_sleep_seconds=0

declare -A GITHUB_VERIFICATION_CACHE_STATE=()
declare -A GITHUB_VERIFICATION_CACHE_VERIFIED=()
declare -A GITHUB_VERIFICATION_CACHE_REASON=()
declare -A GITHUB_VERIFICATION_CACHE_SIGNER=()
declare -A GITHUB_VERIFICATION_CACHE_KEY=()

github_repo_name() {
  if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
    printf '%s\n' "${GITHUB_REPOSITORY}"
    return 0
  fi
  if command -v gh >/dev/null 2>&1; then
    gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true
  fi
}

github_commit_verification() {
  local sha="$1"
  local repo
  repo="$(github_repo_name)"
  if [[ -z "${repo}" ]] || ! command -v gh >/dev/null 2>&1; then
    return 2
  fi

  if [[ -n "${GITHUB_TOKEN:-}" && -z "${GH_TOKEN:-}" ]]; then
    export GH_TOKEN="${GITHUB_TOKEN}"
  fi

  local api_stderr_file
  local api_status=0
  api_stderr_file="$(mktemp)"
  gh api "repos/${repo}/commits/${sha}" \
    --jq '[.commit.verification.verified, .commit.verification.reason, (.commit.verification.signer.login // ""), (.commit.verification.key_id // "")] | @tsv' \
    2>"${api_stderr_file}" || api_status=$?
  if (( api_status == 0 )); then
    rm -f "${api_stderr_file}"
    return 0
  fi

  local api_stderr
  api_stderr="$(<"${api_stderr_file}")"
  rm -f "${api_stderr_file}"
  if [[ "${RELEASE_SIGNATURE_VERBOSE}" == "true" && -n "${api_stderr}" ]]; then
    printf '%s\n' "${api_stderr}" >&2
  fi
  if (( api_status == 4 )) || [[ "${api_stderr}" =~ HTTP[[:space:]]+4[0-9][0-9] ]]; then
    return 3
  fi
  return 1
}

verify_commit_signature_status() {
  local sha="$1"
  local status="$2"
  local signer="$3"
  local key="$4"
  local subject="$5"
  local label="$6"

  case "${status}" in
    G)
      if [[ "${RELEASE_SIGNATURE_VERBOSE}" == "true" ]]; then
        echo "release-signatures: PASS ${label} ${sha} local-signed signer=${signer:-unknown} key=${key:-unknown} subject=${subject}"
      fi
      return 0
      ;;
    B)
      echo "release-signatures: FAIL ${label} ${sha} bad local signature local_status=${status} subject=${subject}" >&2
      return 1
      ;;
    *)
      local cache_state="${GITHUB_VERIFICATION_CACHE_STATE[${sha}]-}"
      if [[ -z "${cache_state}" ]]; then
        local verification=""
        local attempt
        for attempt in 1 2 3; do
          local verification_status
          if verification="$(github_commit_verification "${sha}")"; then
            local verified reason gh_signer gh_key
            IFS=$'\t' read -r verified reason gh_signer gh_key <<<"${verification}"
            GITHUB_VERIFICATION_CACHE_STATE["${sha}"]="available"
            GITHUB_VERIFICATION_CACHE_VERIFIED["${sha}"]="${verified}"
            GITHUB_VERIFICATION_CACHE_REASON["${sha}"]="${reason}"
            GITHUB_VERIFICATION_CACHE_SIGNER["${sha}"]="${gh_signer}"
            GITHUB_VERIFICATION_CACHE_KEY["${sha}"]="${gh_key}"
            cache_state="available"
            break
          else
            verification_status=$?
          fi
          if (( verification_status == 2 || verification_status == 3 )); then
            break
          fi
          if (( attempt < 3 )); then
            local retry_sleep_seconds=$((attempt * 5))
            if (( release_signature_retry_sleep_seconds + retry_sleep_seconds > 10#${RELEASE_SIGNATURE_RETRY_SLEEP_BUDGET_SECONDS} )); then
              break
            fi
            release_signature_retry_sleep_seconds=$((release_signature_retry_sleep_seconds + retry_sleep_seconds))
            sleep "${retry_sleep_seconds}"
          fi
        done
        if [[ -z "${cache_state}" ]]; then
          GITHUB_VERIFICATION_CACHE_STATE["${sha}"]="unavailable"
          cache_state="unavailable"
        fi
      fi

      if [[ "${cache_state}" == "available" ]]; then
        local verified="${GITHUB_VERIFICATION_CACHE_VERIFIED[${sha}]}"
        local reason="${GITHUB_VERIFICATION_CACHE_REASON[${sha}]}"
        local gh_signer="${GITHUB_VERIFICATION_CACHE_SIGNER[${sha}]}"
        local gh_key="${GITHUB_VERIFICATION_CACHE_KEY[${sha}]}"
        if [[ "${verified}" == "true" && "${reason}" == "valid" ]]; then
          echo "release-signatures: PASS ${label} ${sha} github-verified reason=${reason} signer=${gh_signer:-unknown} key=${gh_key:-unknown} local_status=${status} subject=${subject}"
          return 0
        fi
        echo "release-signatures: FAIL ${label} ${sha} local_status=${status} github_verified=${verified:-unknown} reason=${reason:-unknown} subject=${subject}" >&2
        return 1
      fi
      echo "release-signatures: FAIL ${label} ${sha} local_status=${status}; GitHub verification evidence unavailable subject=${subject}" >&2
      return 1
      ;;
  esac
}

scan_range() {
  local label="$1"
  local range="$2"

  if ! git rev-parse --verify --quiet "${range%%..*}^{commit}" >/dev/null; then
    echo "release-signatures: FAIL ${label} missing range base ${range%%..*}" >&2
    return 1
  fi
  if ! git rev-parse --verify --quiet "${range##*..}^{commit}" >/dev/null; then
    echo "release-signatures: FAIL ${label} missing range head ${range##*..}" >&2
    return 1
  fi

  local failures=0
  local scanned=0
  while IFS=$'\x1f' read -r sha status signer key subject; do
    [[ -n "${sha}" ]] || continue
    scanned=$((scanned + 1))
    if ! verify_commit_signature_status "${sha}" "${status}" "${signer}" "${key}" "${subject}" "${label}"; then
      failures=$((failures + 1))
    fi
  done < <(git log --reverse --format='%H%x1f%G?%x1f%GS%x1f%GK%x1f%s' "${range}")

  if (( failures > 0 )); then
    echo "release-signatures: FAIL ${label} (${failures}/${scanned} unacceptable commit signature(s))" >&2
    return 1
  fi

  echo "release-signatures: PASS ${label} (${scanned} commit(s) scanned)"
}

fetch_release_refs_if_possible() {
  if ! git remote get-url origin >/dev/null 2>&1; then
    return 0
  fi

  local refspecs=(
    "+refs/heads/main:refs/remotes/origin/main"
    "+refs/heads/premain:refs/remotes/origin/premain"
    "+refs/heads/staging:refs/remotes/origin/staging"
    "+refs/heads/release-please--branches--main:refs/remotes/origin/release-please--branches--main"
    "+refs/heads/release-please--branches--premain:refs/remotes/origin/release-please--branches--premain"
  )

  if [[ -n "${GITHUB_HEAD_REF:-}" && "${GITHUB_HEAD_REF}" != refs/* ]]; then
    refspecs+=("+refs/heads/${GITHUB_HEAD_REF}:refs/remotes/origin/${GITHUB_HEAD_REF}")
  fi

  git fetch --no-tags origin "${refspecs[@]}" >/dev/null 2>&1 || true
}

scan_default_release_refs() {
  local failures=0
  local refs=(
    origin/main
    origin/premain
    origin/staging
    origin/release-please--branches--main
    origin/release-please--branches--premain
  )

  for ref in "${refs[@]}"; do
    if ! git rev-parse --verify --quiet "${ref}^{commit}" >/dev/null; then
      echo "release-signatures: SKIP ${ref} (ref unavailable)"
      continue
    fi
    if ! git merge-base --is-ancestor "${SIGNED_HISTORY_BASE}" "${ref}"; then
      echo "release-signatures: FAIL ${ref} is not descended from signed-history base ${SIGNED_HISTORY_BASE}" >&2
      failures=$((failures + 1))
      continue
    fi
    if ! scan_range "${ref}" "${SIGNED_HISTORY_BASE}..${ref}"; then
      failures=$((failures + 1))
    fi
  done

  return "${failures}"
}

scan_pr_or_push_range_if_present() {
  local failures=0
  local event_name="${GITHUB_EVENT_NAME:-}"

  if [[ "${event_name}" == "pull_request" ]]; then
    local base_ref="${PR_BASE_REF:-${GITHUB_BASE_REF:-}}"
    local head_sha="${PR_HEAD_SHA:-}"
    if [[ -z "${head_sha}" && -n "${GITHUB_EVENT_PATH:-}" && -f "${GITHUB_EVENT_PATH}" ]]; then
      head_sha="$(python3 - <<'PY'
import json
import os
from pathlib import Path
path = Path(os.environ["GITHUB_EVENT_PATH"])
data = json.loads(path.read_text(encoding="utf-8"))
print(data.get("pull_request", {}).get("head", {}).get("sha", ""))
PY
)"
    fi

    if [[ -n "${base_ref}" && -n "${head_sha}" ]]; then
      local base="origin/${base_ref}"
      if ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
        git fetch --no-tags origin "+refs/heads/${base_ref}:refs/remotes/origin/${base_ref}" >/dev/null 2>&1 || true
      fi
      if git rev-parse --verify --quiet "${base}^{commit}" >/dev/null && git rev-parse --verify --quiet "${head_sha}^{commit}" >/dev/null; then
        if ! scan_range "pull_request:${base_ref}..${head_sha}" "${base}..${head_sha}"; then
          failures=$((failures + 1))
        fi
      else
        echo "release-signatures: FAIL pull_request range unavailable base=${base_ref} head=${head_sha}" >&2
        failures=$((failures + 1))
      fi
    fi
  elif [[ "${event_name}" == "push" ]]; then
    local before="${GITHUB_EVENT_BEFORE:-${GITHUB_BEFORE:-}}"
    local head="${GITHUB_SHA:-}"
    if [[ -n "${head}" ]]; then
      local base="${SIGNED_HISTORY_BASE}"
      if [[ -n "${before}" && ! "${before}" =~ ^0+$ ]]; then
        base="${before}"
      fi
      if git rev-parse --verify --quiet "${base}^{commit}" >/dev/null && git rev-parse --verify --quiet "${head}^{commit}" >/dev/null; then
        if ! scan_range "push:${base}..${head}" "${base}..${head}"; then
          failures=$((failures + 1))
        fi
      else
        echo "release-signatures: FAIL push range unavailable base=${base} head=${head}" >&2
        failures=$((failures + 1))
      fi
    fi
  fi

  return "${failures}"
}

run_self_test() {
  local failures=0

  fetch_release_refs_if_possible

  for ref in origin/main origin/premain origin/staging origin/release-please--branches--main origin/release-please--branches--premain; do
    if ! git rev-parse --verify --quiet "${ref}^{commit}" >/dev/null; then
      echo "release-signatures self-test: FAIL (${ref} unavailable)" >&2
      failures=$((failures + 1))
      continue
    fi
    if ! scan_range "self-test:${ref}" "${SIGNED_HISTORY_BASE}..${ref}"; then
      failures=$((failures + 1))
    fi
  done

  if ! git rev-parse --verify --quiet "${HISTORICAL_UNSIGNED_FIXTURE}^{commit}" >/dev/null; then
    echo "release-signatures self-test: FAIL (historical unsigned fixture ${HISTORICAL_UNSIGNED_FIXTURE} unavailable)" >&2
    failures=$((failures + 1))
  else
    local fixture_output
    local fixture_status=0
    fixture_output="$(scan_range "self-test:historical-unsigned-fixture" "${HISTORICAL_UNSIGNED_FIXTURE}^..${HISTORICAL_UNSIGNED_FIXTURE}" 2>&1)" || fixture_status=$?
    if [[ "${fixture_status}" -eq 0 ]]; then
      echo "release-signatures self-test: FAIL (historical unsigned fixture unexpectedly passed)" >&2
      echo "${fixture_output}" >&2
      failures=$((failures + 1))
    elif [[ "${fixture_output}" != *"local_status=N"* && "${fixture_output}" != *"%G?=N"* ]]; then
      echo "release-signatures self-test: FAIL (historical unsigned fixture failed for the wrong reason)" >&2
      echo "${fixture_output}" >&2
      failures=$((failures + 1))
    else
      echo "release-signatures self-test: PASS historical unsigned fixture failed closed"
      echo "${fixture_output}"
    fi
  fi

  local github_fallback_output
  local github_fallback_status=0
  github_fallback_output="$(
    local github_fallback_sha="0123456789abcdef0123456789abcdef01234567"
    github_commit_verification() {
      local requested_sha="$1"
      if [[ "${requested_sha}" == "${github_fallback_sha}" ]]; then
        printf 'true\tvalid\tgithub-self-test\tself-test-key\n'
        return 0
      fi
      return 1
    }
    verify_commit_signature_status \
      "${github_fallback_sha}" \
      "N" \
      "" \
      "" \
      "self-test simulated GitHub verified commit" \
      "self-test:github-verified-fallback"
  )" || github_fallback_status=$?
  if [[ "${github_fallback_status}" -ne 0 ]]; then
    echo "release-signatures self-test: FAIL (GitHub verified-valid fallback rejected)" >&2
    echo "${github_fallback_output}" >&2
    failures=$((failures + 1))
  elif [[ "${github_fallback_output}" != *"github-verified"* || "${github_fallback_output}" != *"local_status=N"* ]]; then
    echo "release-signatures self-test: FAIL (GitHub fallback did not report github-verified with local_status=N)" >&2
    echo "${github_fallback_output}" >&2
    failures=$((failures + 1))
  else
    echo "release-signatures self-test: PASS GitHub verified-valid fallback for local_status=N"
    echo "${github_fallback_output}"
  fi

  local dedupe_count_file
  dedupe_count_file="$(mktemp)"
  local dedupe_output
  local dedupe_status=0
  dedupe_output="$(
    github_commit_verification() {
      printf '%s\n' "$1" >>"${dedupe_count_file}"
      printf 'true\tvalid\tgithub-self-test\tself-test-key\n'
    }
    git() {
      if [[ "$1" == "rev-parse" ]]; then
        return 0
      fi
      if [[ "$1" == "log" ]]; then
        printf '0123456789abcdef0123456789abcdef01234567\x1fN\x1f\x1f\x1fself-test simulated duplicate commit\n'
        return 0
      fi
      command git "$@"
    }
    scan_range "self-test:dedupe-range-one" "dedupe-base-one..dedupe-head-one"
    scan_range "self-test:dedupe-range-two" "dedupe-base-two..dedupe-head-two"
  )" || dedupe_status=$?
  local dedupe_calls
  dedupe_calls="$(wc -l <"${dedupe_count_file}")"
  rm -f "${dedupe_count_file}"
  if [[ "${dedupe_status}" -ne 0 ]]; then
    echo "release-signatures self-test: FAIL (cross-range GitHub verification dedupe scan failed)" >&2
    echo "${dedupe_output}" >&2
    failures=$((failures + 1))
  elif [[ "${dedupe_calls}" -ne 1 ]]; then
    echo "release-signatures self-test: FAIL (cross-range GitHub verification dedupe called helper ${dedupe_calls} times, expected 1)" >&2
    echo "${dedupe_output}" >&2
    failures=$((failures + 1))
  else
    echo "release-signatures self-test: PASS cross-range GitHub verification dedupe"
    echo "${dedupe_output}"
  fi

  if (( failures > 0 )); then
    echo "release-signatures self-test: FAIL (${failures} issue(s))" >&2
    exit 1
  fi

  echo "release-signatures self-test: PASS"
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
  exit 0
fi

ranges=()
labels=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --range)
      ranges+=("${2:-}")
      shift 2
      ;;
    --label)
      labels+=("${2:-}")
      shift 2
      ;;
    --help|-h)
      cat <<'USAGE'
usage: scripts/verify-release-branch-signatures.sh [--self-test] [--range <base..head> [--label <label>]]...

Without explicit ranges, scans repaired protected/release-please branch history from the
signed-history repair base and any GitHub Actions pull_request or push range in the environment.
USAGE
      exit 0
      ;;
    *)
      echo "release-signatures: FAIL (unknown argument: $1)" >&2
      exit 1
      ;;
  esac
done

failures=0

if (( ${#ranges[@]} > 0 )); then
  for index in "${!ranges[@]}"; do
    label="${labels[${index}]:-range:${ranges[${index}]} }"
    if ! scan_range "${label}" "${ranges[${index}]}"; then
      failures=$((failures + 1))
    fi
  done
else
  fetch_release_refs_if_possible
  if ! scan_default_release_refs; then
    failures=$((failures + 1))
  fi
  if ! scan_pr_or_push_range_if_present; then
    failures=$((failures + 1))
  fi
fi

if (( failures > 0 )); then
  echo "release-signatures: FAIL (${failures} range(s) failed)" >&2
  exit 1
fi

echo "release-signatures: PASS"
