#!/usr/bin/env bash
# Purpose: fail closed when release/protected branch history contains unsigned commits.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

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
declare -A GITHUB_VERIFICATION_CACHE_STDERR=()
declare -A GITHUB_VERIFICATION_CACHE_STDERR_REPORTED=()
declare -A SCANNED_COMMIT_SHAS=()

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
  if [[ -n "${GITHUB_VERIFICATION_STDERR_FILE:-}" ]]; then
    printf '%s' "${api_stderr}" >"${GITHUB_VERIFICATION_STDERR_FILE}"
  fi
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
        local verification_stderr_file
        verification_stderr_file="$(mktemp)"
        local GITHUB_VERIFICATION_STDERR_FILE="${verification_stderr_file}"
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
            # 10# is safe only because the ^[0-9]+$ guard above guarantees non-empty digits.
            if (( release_signature_retry_sleep_seconds + retry_sleep_seconds > 10#${RELEASE_SIGNATURE_RETRY_SLEEP_BUDGET_SECONDS} )); then
              break
            fi
            release_signature_retry_sleep_seconds=$((release_signature_retry_sleep_seconds + retry_sleep_seconds))
            sleep "${retry_sleep_seconds}"
          fi
        done
        local verification_stderr=""
        if [[ -s "${verification_stderr_file}" ]]; then
          verification_stderr="$(<"${verification_stderr_file}")"
        fi
        rm -f "${verification_stderr_file}"
        if [[ -z "${cache_state}" ]]; then
          GITHUB_VERIFICATION_CACHE_STATE["${sha}"]="unavailable"
          GITHUB_VERIFICATION_CACHE_STDERR["${sha}"]="${verification_stderr}"
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
      local verification_stderr="${GITHUB_VERIFICATION_CACHE_STDERR[${sha}]-}"
      if [[ "${RELEASE_SIGNATURE_VERBOSE}" != "true" && -n "${verification_stderr}" && "${GITHUB_VERIFICATION_CACHE_STDERR_REPORTED[${sha}]-}" != "true" ]]; then
        printf '%s\n' "${verification_stderr}" >&2
        GITHUB_VERIFICATION_CACHE_STDERR_REPORTED["${sha}"]="true"
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
    # Bound the work to the unique new commits the current event introduces:
    # overlapping ranges and already-proven duplicates are not re-verified.
    if [[ -n "${SCANNED_COMMIT_SHAS[${sha}]-}" ]]; then
      continue
    fi
    SCANNED_COMMIT_SHAS["${sha}"]=1
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

  # Only the accepted protected branches are needed: a pull_request or push
  # event carries its own before/base SHA, and a dispatch on a generated release
  # branch needs the accepted branch it will merge into. Scanning unrelated ref
  # histories is exactly what this gate stopped doing.
  local refspecs=(
    "+refs/heads/main:refs/remotes/origin/main"
    "+refs/heads/premain:refs/remotes/origin/premain"
    "+refs/heads/staging:refs/remotes/origin/staging"
  )

  git fetch --no-tags origin "${refspecs[@]}" >/dev/null 2>&1 || true
}

event_payload_field() {
  local path="$1"
  if [[ -z "${GITHUB_EVENT_PATH:-}" || ! -f "${GITHUB_EVENT_PATH}" ]]; then
    return 1
  fi
  python3 - "${GITHUB_EVENT_PATH}" "${path}" <<'PY'
import json
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
value = data
for part in sys.argv[2].split("."):
    if not isinstance(value, dict):
        value = None
        break
    value = value.get(part)
print(value if isinstance(value, str) else "")
PY
}

# Emit one trusted base..head range for the current event, or fail closed.
#
# The base is the event's own accepted base: the pull request's base commit, the
# push's before commit, or the accepted protected branch a dispatched release PR
# merges into. An arbitrary ancestor tag is never treated as proof of published
# history. Both endpoints must resolve, the base must be an ancestor of the head
# (a rewritten base fails closed), and a missing base is an error, not a reason
# to widen the scan.
event_signed_range() {
  local event_name="${GITHUB_EVENT_NAME:-}"

  if [[ "${event_name}" == "pull_request" ]]; then
    local base="${PR_BASE_SHA:-}"
    local head="${PR_HEAD_SHA:-${GITHUB_SHA:-}}"
    if [[ -z "${base}" ]]; then
      base="$(event_payload_field "pull_request.base.sha" 2>/dev/null || true)"
    fi
    if [[ -z "${head}" ]]; then
      head="$(event_payload_field "pull_request.head.sha" 2>/dev/null || true)"
    fi
    if [[ -z "${base}" || -z "${head}" ]]; then
      echo "release-signatures: FAIL pull_request event has no base/head commit to bound the new range" >&2
      return 1
    fi
    signed_range_from "pull_request:${event_name}" "${base}" "${head}"
    return $?
  fi

  if [[ "${event_name}" == "push" ]]; then
    local base="${GITHUB_EVENT_BEFORE:-${GITHUB_BEFORE:-}}"
    local head="${GITHUB_SHA:-}"
    if [[ -z "${base}" ]]; then
      base="$(event_payload_field "before" 2>/dev/null || true)"
    fi
    if [[ -z "${head}" ]]; then
      head="$(event_payload_field "after" 2>/dev/null || true)"
    fi
    if [[ -z "${base}" || "${base}" =~ ^0+$ ]]; then
      echo "release-signatures: FAIL push event has no before commit to bound the new range" >&2
      return 1
    fi
    if [[ -z "${head}" ]]; then
      echo "release-signatures: FAIL push event has no head commit" >&2
      return 1
    fi
    signed_range_from "push:${event_name}" "${base}" "${head}"
    return $?
  fi

  if [[ "${event_name}" == "workflow_dispatch" ]]; then
    local ref_name="${GITHUB_REF_NAME:-${GITHUB_REF#refs/heads/}}"
    local head="${GITHUB_SHA:-}"
    local base_ref=""
    case "${ref_name}" in
      release-please--branches--premain) base_ref="origin/premain" ;;
      release-please--branches--main) base_ref="origin/main" ;;
      premain | staging | main) base_ref="origin/${ref_name}" ;;
      *)
        echo "release-signatures: FAIL workflow_dispatch ref ${ref_name:-unknown} has no accepted base branch" >&2
        return 1
        ;;
    esac
    if [[ -z "${head}" ]]; then
      echo "release-signatures: FAIL workflow_dispatch event has no head commit" >&2
      return 1
    fi
    if ! git rev-parse --verify --quiet "${base_ref}^{commit}" >/dev/null; then
      echo "release-signatures: FAIL workflow_dispatch base ${base_ref} is unavailable" >&2
      return 1
    fi
    signed_range_from "workflow_dispatch:${ref_name}" "${base_ref}" "${head}"
    return $?
  fi

  echo "release-signatures: FAIL no release event and no explicit --range; pass --range <base..head> for a manual audit" >&2
  return 1
}

signed_range_from() {
  local label="$1"
  local base="$2"
  local head="$3"
  if ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
    echo "release-signatures: FAIL ${label} base ${base} is unavailable locally" >&2
    return 1
  fi
  if ! git rev-parse --verify --quiet "${head}^{commit}" >/dev/null; then
    echo "release-signatures: FAIL ${label} head ${head} is unavailable locally" >&2
    return 1
  fi
  if ! git merge-base --is-ancestor "${base}" "${head}"; then
    echo "release-signatures: FAIL ${label} base ${base} is not an ancestor of ${head}" >&2
    return 1
  fi
  scan_range "${label}" "${base}..${head}"
}

run_self_test() {
  local failures=0

  # Event base selection is exercised with a stubbed scan_range: only the
  # event's own range may be scanned, never the five-ref historical sweep.
  local scanned_ranges_file
  scanned_ranges_file="$(mktemp)"
  local event_output
  local event_status
  event_output="$(
    scan_range() {
      printf '%s %s\n' "$1" "$2" >>"${scanned_ranges_file}"
      return 0
    }
    git() {
      case "$1" in
        rev-parse) return 0 ;;
        merge-base) return 0 ;;
      esac
      command git "$@"
    }
    GITHUB_EVENT_NAME=pull_request \
      PR_BASE_SHA=1111111111111111111111111111111111111111 \
      PR_HEAD_SHA=2222222222222222222222222222222222222222 \
      event_signed_range
  )" || event_status=$?
  if [[ "${event_status:-0}" -ne 0 ]]; then
    echo "release-signatures self-test: FAIL (pull_request event range was rejected)" >&2
    echo "${event_output}" >&2
    failures=$((failures + 1))
  elif [[ "$(wc -l <"${scanned_ranges_file}" | tr -d ' ')" != "1" ]] ||
    ! grep -Fq "1111111111111111111111111111111111111111..2222222222222222222222222222222222222222" "${scanned_ranges_file}"; then
    echo "release-signatures self-test: FAIL (pull_request event scanned more than its own range)" >&2
    cat "${scanned_ranges_file}" >&2
    failures=$((failures + 1))
  else
    echo "release-signatures self-test: PASS pull_request scans exactly its base..head range"
  fi
  : >"${scanned_ranges_file}"

  event_status=0
  event_output="$(
    scan_range() { printf '%s %s\n' "$1" "$2" >>"${scanned_ranges_file}"; return 0; }
    git() {
      case "$1" in
        rev-parse) return 0 ;;
        merge-base) return 0 ;;
      esac
      command git "$@"
    }
    GITHUB_EVENT_NAME=push \
      GITHUB_EVENT_BEFORE=3333333333333333333333333333333333333333 \
      GITHUB_SHA=4444444444444444444444444444444444444444 \
      event_signed_range
  )" || event_status=$?
  if [[ "${event_status:-0}" -ne 0 ]] || ! grep -Fq "3333333333333333333333333333333333333333..4444444444444444444444444444444444444444" "${scanned_ranges_file}"; then
    echo "release-signatures self-test: FAIL (push event range was not bounded by before..head)" >&2
    echo "${event_output}" >&2
    cat "${scanned_ranges_file}" >&2
    failures=$((failures + 1))
  else
    echo "release-signatures self-test: PASS push scans exactly its before..head range"
  fi
  : >"${scanned_ranges_file}"

  # Missing base fails closed: a zero before SHA and an absent base are not
  # reasons to fall back to a tag or to the whole history.
  event_status=0
  event_output="$(
    scan_range() { printf 'unexpected\n' >>"${scanned_ranges_file}"; return 0; }
    GITHUB_EVENT_NAME=push GITHUB_EVENT_BEFORE=0000000000000000000000000000000000000000 GITHUB_SHA=4444444444444444444444444444444444444444 event_signed_range
  )" || event_status=$?
  if [[ "${event_status}" -eq 0 || -s "${scanned_ranges_file}" ]]; then
    echo "release-signatures self-test: FAIL (zero push base did not fail closed)" >&2
    echo "${event_output}" >&2
    failures=$((failures + 1))
  else
    echo "release-signatures self-test: PASS missing push base fails closed"
  fi

  event_status=0
  event_output="$(
    scan_range() { printf 'unexpected\n' >>"${scanned_ranges_file}"; return 0; }
    GITHUB_EVENT_NAME=pull_request PR_BASE_SHA= PR_HEAD_SHA= event_signed_range
  )" || event_status=$?
  if [[ "${event_status}" -eq 0 || -s "${scanned_ranges_file}" ]]; then
    echo "release-signatures self-test: FAIL (absent pull_request base did not fail closed)" >&2
    echo "${event_output}" >&2
    failures=$((failures + 1))
  else
    echo "release-signatures self-test: PASS missing pull_request base fails closed"
  fi
  : >"${scanned_ranges_file}"

  # A base that is not an ancestor of the head fails closed instead of being
  # scanned blindly.
  event_status=0
  event_output="$(
    scan_range() { printf 'unexpected\n' >>"${scanned_ranges_file}"; return 0; }
    git() {
      case "$1" in
        rev-parse) return 0 ;;
        merge-base) return 1 ;;
      esac
      command git "$@"
    }
    GITHUB_EVENT_NAME=pull_request \
      PR_BASE_SHA=1111111111111111111111111111111111111111 \
      PR_HEAD_SHA=2222222222222222222222222222222222222222 \
      event_signed_range
  )" || event_status=$?
  if [[ "${event_status}" -eq 0 || -s "${scanned_ranges_file}" ]]; then
    echo "release-signatures self-test: FAIL (non-ancestor base did not fail closed)" >&2
    echo "${event_output}" >&2
    failures=$((failures + 1))
  else
    echo "release-signatures self-test: PASS non-ancestor base fails closed"
  fi
  : >"${scanned_ranges_file}"

  # No event and no explicit range fails closed rather than sweeping history.
  event_status=0
  event_output="$(
    scan_range() { printf 'unexpected\n' >>"${scanned_ranges_file}"; return 0; }
    event_signed_range
  )" || event_status=$?
  if [[ "${event_status}" -eq 0 || -s "${scanned_ranges_file}" ]]; then
    echo "release-signatures self-test: FAIL (missing event did not fail closed)" >&2
    echo "${event_output}" >&2
    failures=$((failures + 1))
  else
    echo "release-signatures self-test: PASS missing event fails closed"
  fi
  rm -f "${scanned_ranges_file}"

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

  local auth_calls_file auth_sleeps_file
  auth_calls_file="$(mktemp)"
  auth_sleeps_file="$(mktemp)"
  local auth_output
  local auth_status=0
  auth_output="$(
    GITHUB_REPOSITORY="theory-cloud/AppTheory"
    RELEASE_SIGNATURE_VERBOSE=false
    RELEASE_SIGNATURE_RETRY_SLEEP_BUDGET_SECONDS=300
    release_signature_retry_sleep_seconds=0
    gh() {
      printf '%s\n' "$*" >>"${auth_calls_file}"
      echo "self-test gh auth not configured" >&2
      return 4
    }
    sleep() {
      printf '%s\n' "$1" >>"${auth_sleeps_file}"
    }
    {
      verify_commit_signature_status \
        "1123456789abcdef0123456789abcdef01234567" \
        "N" \
        "" \
        "" \
        "self-test simulated gh auth failure" \
        "self-test:gh-auth-permanent" || true
      verify_commit_signature_status \
        "1123456789abcdef0123456789abcdef01234567" \
        "N" \
        "" \
        "" \
        "self-test simulated cached gh auth failure" \
        "self-test:gh-auth-permanent-cached"
    } 2>&1
  )" || auth_status=$?
  local auth_calls auth_sleeps auth_stderr_count
  auth_calls="$(wc -l <"${auth_calls_file}")"
  auth_sleeps="$(wc -l <"${auth_sleeps_file}")"
  auth_stderr_count="$(grep -cF "self-test gh auth not configured" <<<"${auth_output}" || true)"
  rm -f "${auth_calls_file}" "${auth_sleeps_file}"
  if [[ "${auth_status}" -eq 0 ]]; then
    echo "release-signatures self-test: FAIL (gh exit 4 unexpectedly passed verification)" >&2
    echo "${auth_output}" >&2
    failures=$((failures + 1))
  elif [[ "${auth_calls}" -ne 1 || "${auth_sleeps}" -ne 0 ]]; then
    echo "release-signatures self-test: FAIL (gh exit 4 was retried: calls=${auth_calls} sleeps=${auth_sleeps})" >&2
    echo "${auth_output}" >&2
    failures=$((failures + 1))
  elif [[ "${auth_stderr_count}" -ne 1 ]]; then
    echo "release-signatures self-test: FAIL (terminal gh exit 4 stderr surfaced ${auth_stderr_count} times, expected 1)" >&2
    echo "${auth_output}" >&2
    failures=$((failures + 1))
  else
    echo "release-signatures self-test: PASS gh exit 4 is permanent without retries"
    echo "${auth_output}"
  fi

  local http_4xx_calls_file http_4xx_sleeps_file
  http_4xx_calls_file="$(mktemp)"
  http_4xx_sleeps_file="$(mktemp)"
  local http_4xx_output
  local http_4xx_status=0
  http_4xx_output="$(
    GITHUB_REPOSITORY="theory-cloud/AppTheory"
    RELEASE_SIGNATURE_VERBOSE=false
    RELEASE_SIGNATURE_RETRY_SLEEP_BUDGET_SECONDS=300
    release_signature_retry_sleep_seconds=0
    gh() {
      printf '%s\n' "$*" >>"${http_4xx_calls_file}"
      echo "gh: Bad credentials (HTTP 401)" >&2
      return 1
    }
    sleep() {
      printf '%s\n' "$1" >>"${http_4xx_sleeps_file}"
    }
    verify_commit_signature_status \
      "4123456789abcdef0123456789abcdef01234567" \
      "N" \
      "" \
      "" \
      "self-test simulated gh HTTP 401 failure" \
      "self-test:gh-http-4xx-permanent" 2>&1
  )" || http_4xx_status=$?
  local http_4xx_calls http_4xx_sleeps http_4xx_stderr_count
  http_4xx_calls="$(wc -l <"${http_4xx_calls_file}")"
  http_4xx_sleeps="$(wc -l <"${http_4xx_sleeps_file}")"
  http_4xx_stderr_count="$(grep -cF "gh: Bad credentials (HTTP 401)" <<<"${http_4xx_output}" || true)"
  rm -f "${http_4xx_calls_file}" "${http_4xx_sleeps_file}"
  if [[ "${http_4xx_status}" -eq 0 ]]; then
    echo "release-signatures self-test: FAIL (gh HTTP 401 unexpectedly passed verification)" >&2
    echo "${http_4xx_output}" >&2
    failures=$((failures + 1))
  elif [[ "${http_4xx_calls}" -ne 1 || "${http_4xx_sleeps}" -ne 0 ]]; then
    echo "release-signatures self-test: FAIL (gh HTTP 401 was retried: calls=${http_4xx_calls} sleeps=${http_4xx_sleeps})" >&2
    echo "${http_4xx_output}" >&2
    failures=$((failures + 1))
  elif [[ "${http_4xx_stderr_count}" -ne 1 || "${http_4xx_output}" != *"GitHub verification evidence unavailable"* ]]; then
    echo "release-signatures self-test: FAIL (gh HTTP 401 did not fail closed through unavailable evidence)" >&2
    echo "${http_4xx_output}" >&2
    failures=$((failures + 1))
  else
    echo "release-signatures self-test: PASS gh HTTP 401 is permanent without retries"
    echo "${http_4xx_output}"
  fi

  local http_5xx_calls_file http_5xx_sleeps_file
  http_5xx_calls_file="$(mktemp)"
  http_5xx_sleeps_file="$(mktemp)"
  local http_5xx_output
  local http_5xx_status=0
  http_5xx_output="$(
    GITHUB_REPOSITORY="theory-cloud/AppTheory"
    RELEASE_SIGNATURE_VERBOSE=false
    RELEASE_SIGNATURE_RETRY_SLEEP_BUDGET_SECONDS=300
    release_signature_retry_sleep_seconds=0
    gh() {
      printf '%s\n' "$*" >>"${http_5xx_calls_file}"
      echo "gh: Service Unavailable (HTTP 503)" >&2
      return 1
    }
    sleep() {
      printf '%s\n' "$1" >>"${http_5xx_sleeps_file}"
    }
    verify_commit_signature_status \
      "6123456789abcdef0123456789abcdef01234567" \
      "N" \
      "" \
      "" \
      "self-test simulated gh HTTP 503 failure" \
      "self-test:gh-http-5xx-transient" 2>&1
  )" || http_5xx_status=$?
  local http_5xx_calls http_5xx_sleeps http_5xx_stderr_count
  http_5xx_calls="$(wc -l <"${http_5xx_calls_file}")"
  http_5xx_sleeps="$(tr '\n' ' ' <"${http_5xx_sleeps_file}")"
  http_5xx_stderr_count="$(grep -cF "gh: Service Unavailable (HTTP 503)" <<<"${http_5xx_output}" || true)"
  rm -f "${http_5xx_calls_file}" "${http_5xx_sleeps_file}"
  if [[ "${http_5xx_status}" -eq 0 ]]; then
    echo "release-signatures self-test: FAIL (gh HTTP 503 unexpectedly passed verification)" >&2
    echo "${http_5xx_output}" >&2
    failures=$((failures + 1))
  elif [[ "${http_5xx_calls}" -ne 3 || "${http_5xx_sleeps}" != "5 10 " ]]; then
    echo "release-signatures self-test: FAIL (gh HTTP 503 did not exhaust retries: calls=${http_5xx_calls} sleeps=${http_5xx_sleeps:-none})" >&2
    echo "${http_5xx_output}" >&2
    failures=$((failures + 1))
  elif [[ "${http_5xx_stderr_count}" -ne 1 || "${http_5xx_output}" != *"GitHub verification evidence unavailable"* ]]; then
    echo "release-signatures self-test: FAIL (gh HTTP 503 did not fail closed through unavailable evidence)" >&2
    echo "${http_5xx_output}" >&2
    failures=$((failures + 1))
  else
    echo "release-signatures self-test: PASS gh HTTP 503 is transient with bounded retries"
    echo "${http_5xx_output}"
  fi

  local budget_calls_file budget_sleeps_file
  budget_calls_file="$(mktemp)"
  budget_sleeps_file="$(mktemp)"
  local budget_output
  local budget_status=0
  budget_output="$(
    RELEASE_SIGNATURE_RETRY_SLEEP_BUDGET_SECONDS=0008
    release_signature_retry_sleep_seconds=0
    github_commit_verification() {
      printf '%s\n' "$1" >>"${budget_calls_file}"
      return 1
    }
    sleep() {
      printf '%s\n' "$1" >>"${budget_sleeps_file}"
    }
    verify_commit_signature_status \
      "2123456789abcdef0123456789abcdef01234567" \
      "N" \
      "" \
      "" \
      "self-test simulated padded retry budget" \
      "self-test:padded-retry-budget" 2>&1
  )" || budget_status=$?
  local budget_calls budget_sleeps
  budget_calls="$(wc -l <"${budget_calls_file}")"
  budget_sleeps="$(tr '\n' ' ' <"${budget_sleeps_file}")"
  rm -f "${budget_calls_file}" "${budget_sleeps_file}"
  if [[ "${budget_status}" -eq 0 ]]; then
    echo "release-signatures self-test: FAIL (padded retry budget unexpectedly passed verification)" >&2
    echo "${budget_output}" >&2
    failures=$((failures + 1))
  elif [[ "${budget_output}" == *"value too great for base"* ]]; then
    echo "release-signatures self-test: FAIL (padded retry budget triggered octal arithmetic)" >&2
    echo "${budget_output}" >&2
    failures=$((failures + 1))
  elif [[ "${budget_calls}" -ne 2 || "${budget_sleeps}" != "5 " ]]; then
    echo "release-signatures self-test: FAIL (padded retry budget was not enforced: calls=${budget_calls} sleeps=${budget_sleeps:-none})" >&2
    echo "${budget_output}" >&2
    failures=$((failures + 1))
  else
    echo "release-signatures self-test: PASS padded retry budget is decimal and enforced"
    echo "${budget_output}"
  fi

  local verbose_calls_file verbose_sleeps_file quiet_calls_file quiet_sleeps_file
  verbose_calls_file="$(mktemp)"
  verbose_sleeps_file="$(mktemp)"
  quiet_calls_file="$(mktemp)"
  quiet_sleeps_file="$(mktemp)"
  local verbose_output quiet_output
  local verbose_status=0 quiet_status=0
  verbose_output="$(
    GITHUB_REPOSITORY="theory-cloud/AppTheory"
    RELEASE_SIGNATURE_VERBOSE=true
    RELEASE_SIGNATURE_RETRY_SLEEP_BUDGET_SECONDS=300
    release_signature_retry_sleep_seconds=0
    gh() {
      printf '%s\n' "$*" >>"${verbose_calls_file}"
      echo "self-test verbose gh stderr" >&2
      return 1
    }
    sleep() {
      printf '%s\n' "$1" >>"${verbose_sleeps_file}"
    }
    verify_commit_signature_status \
      "3123456789abcdef0123456789abcdef01234567" \
      "N" \
      "" \
      "" \
      "self-test simulated verbose gh failure" \
      "self-test:verbose-gh-stderr" 2>&1
  )" || verbose_status=$?
  quiet_output="$(
    GITHUB_REPOSITORY="theory-cloud/AppTheory"
    RELEASE_SIGNATURE_VERBOSE=false
    RELEASE_SIGNATURE_RETRY_SLEEP_BUDGET_SECONDS=300
    release_signature_retry_sleep_seconds=0
    gh() {
      printf '%s\n' "$*" >>"${quiet_calls_file}"
      echo "self-test quiet gh stderr" >&2
      return 1
    }
    sleep() {
      printf '%s\n' "$1" >>"${quiet_sleeps_file}"
    }
    verify_commit_signature_status \
      "5123456789abcdef0123456789abcdef01234567" \
      "N" \
      "" \
      "" \
      "self-test simulated quiet gh failure" \
      "self-test:quiet-gh-stderr" 2>&1
  )" || quiet_status=$?
  local verbose_calls verbose_sleeps quiet_calls quiet_sleeps verbose_stderr_count quiet_stderr_count
  verbose_calls="$(wc -l <"${verbose_calls_file}")"
  verbose_sleeps="$(tr '\n' ' ' <"${verbose_sleeps_file}")"
  quiet_calls="$(wc -l <"${quiet_calls_file}")"
  quiet_sleeps="$(tr '\n' ' ' <"${quiet_sleeps_file}")"
  verbose_stderr_count="$(grep -cF "self-test verbose gh stderr" <<<"${verbose_output}" || true)"
  quiet_stderr_count="$(grep -cF "self-test quiet gh stderr" <<<"${quiet_output}" || true)"
  rm -f "${verbose_calls_file}" "${verbose_sleeps_file}" "${quiet_calls_file}" "${quiet_sleeps_file}"
  if [[ "${verbose_status}" -eq 0 || "${quiet_status}" -eq 0 ]]; then
    echo "release-signatures self-test: FAIL (terminal gh stderr fixture unexpectedly passed verification)" >&2
    echo "${verbose_output}" >&2
    echo "${quiet_output}" >&2
    failures=$((failures + 1))
  elif [[ "${verbose_calls}" -ne 3 || "${verbose_sleeps}" != "5 10 " || "${quiet_calls}" -ne 3 || "${quiet_sleeps}" != "5 10 " ]]; then
    echo "release-signatures self-test: FAIL (terminal gh stderr fixture did not exhaust retries: verbose_calls=${verbose_calls} verbose_sleeps=${verbose_sleeps:-none} quiet_calls=${quiet_calls} quiet_sleeps=${quiet_sleeps:-none})" >&2
    echo "${verbose_output}" >&2
    echo "${quiet_output}" >&2
    failures=$((failures + 1))
  elif [[ "${verbose_stderr_count}" -ne 3 ]]; then
    echo "release-signatures self-test: FAIL (verbose gh stderr surfaced ${verbose_stderr_count} times, expected 3)" >&2
    echo "${verbose_output}" >&2
    failures=$((failures + 1))
  elif [[ "${quiet_stderr_count}" -ne 1 ]]; then
    echo "release-signatures self-test: FAIL (non-verbose gh stderr surfaced ${quiet_stderr_count} times, expected 1)" >&2
    echo "${quiet_output}" >&2
    failures=$((failures + 1))
  else
    echo "release-signatures self-test: PASS terminal gh stderr count follows verbose mode"
    echo "${verbose_output}"
    echo "${quiet_output}"
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

Without explicit ranges, scans exactly the new commits the current release event
introduces, bounded by that event's own accepted base: a pull request's base
commit (base.sha), a push's before commit, or the accepted protected branch a
dispatched generated release PR merges into. A missing base, a base that is not
an ancestor of the head, or no event at all fails closed. No ancestor tag is
treated as proof of published history, and unrelated ref histories are never
scanned.
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
  if ! event_signed_range; then
    failures=$((failures + 1))
  fi
fi

if (( failures > 0 )); then
  echo "release-signatures: FAIL (${failures} range(s) failed)" >&2
  exit 1
fi

echo "release-signatures: PASS"
