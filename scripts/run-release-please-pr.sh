#!/usr/bin/env bash
# Purpose: run release-please locally for the selected release branch.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
  cat >&2 <<'USAGE'
run-release-please-pr: usage:
  scripts/run-release-please-pr.sh \
    --target-branch <branch> \
    --config-file <path> \
    --manifest-file <path> \
    [--release-as <version>] \
    [--release-branch <branch>]
USAGE
}

target_branch=""
config_file=""
manifest_file=""
release_as=""
release_branch=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-branch)
      target_branch="${2:-}"
      shift 2
      ;;
    --config-file)
      config_file="${2:-}"
      shift 2
      ;;
    --manifest-file)
      manifest_file="${2:-}"
      shift 2
      ;;
    --release-as)
      release_as="${2:-}"
      shift 2
      ;;
    --release-branch)
      release_branch="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "release-please-pr: FAIL (unknown argument $1)" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${target_branch}" || -z "${config_file}" || -z "${manifest_file}" ]]; then
  usage
  exit 1
fi

if [[ -z "${release_branch}" ]]; then
  release_branch="release-please--branches--${target_branch}"
fi

if [[ -z "${RELEASE_PLEASE_TOKEN:-}" ]]; then
  echo "release-please-pr: FAIL (RELEASE_PLEASE_TOKEN is required)" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "release-please-pr: FAIL (gh not found)" >&2
  exit 1
fi

detect_open_release_pr() {
  gh pr list \
    --state open \
    --base "${target_branch}" \
    --head "${release_branch}" \
    --json number,isDraft,baseRefName,headRefName,state \
    --jq '.[0] // empty' \
    2>/dev/null || true
}

draft_lock_release_pr() {
  local pr_number="$1"
  local is_draft

  is_draft="$(gh pr view "${pr_number}" --json isDraft --jq '.isDraft')"
  if [[ "${is_draft}" != "true" ]]; then
    echo "release-please-pr: draft-locking open release PR #${pr_number}"
    gh pr ready "${pr_number}" --undo
  fi

  is_draft="$(gh pr view "${pr_number}" --json isDraft --jq '.isDraft')"
  if [[ "${is_draft}" != "true" ]]; then
    echo "release-please-pr: FAIL (PR #${pr_number} could not be draft-locked)" >&2
    exit 1
  fi
}

use_existing_open_release_pr() {
  local context="$1"
  local pr_json
  pr_json="$(detect_open_release_pr)"
  if [[ -z "${pr_json}" ]]; then
    return 1
  fi

  local pr_number
  pr_number="$(jq -r '.number' <<<"${pr_json}")"
  if [[ -z "${pr_number}" || "${pr_number}" == "null" ]]; then
    return 1
  fi

  draft_lock_release_pr "${pr_number}"
  echo "release-please-pr: PASS (${context}; using open draft ${target_branch} release PR #${pr_number})"
  return 0
}

draft_lock_existing_open_release_pr_before_refresh() {
  local pr_json
  pr_json="$(detect_open_release_pr)"
  if [[ -z "${pr_json}" ]]; then
    return 0
  fi

  local pr_number
  pr_number="$(jq -r '.number' <<<"${pr_json}")"
  if [[ -z "${pr_number}" || "${pr_number}" == "null" ]]; then
    return 0
  fi

  draft_lock_release_pr "${pr_number}"
  echo "release-please-pr: found open ${target_branch} release PR #${pr_number}; refreshing it through release-please"
}

draft_lock_existing_open_release_pr_before_refresh

args=(
  -y
  release-please@17.1.3
  release-pr
  --token "${RELEASE_PLEASE_TOKEN}"
  --repo-url "${GITHUB_REPOSITORY}"
  --target-branch "${target_branch}"
  --config-file "${config_file}"
  --manifest-file "${manifest_file}"
  --draft-pull-request
)

if [[ -n "${release_as}" ]]; then
  args+=(--release-as "${release_as}")
fi

set +e
npx "${args[@]}"
release_please_status=$?
set -e

if [[ "${release_please_status}" -ne 0 ]]; then
  if use_existing_open_release_pr "release-please exited ${release_please_status} after creating or finding a release PR"; then
    exit 0
  fi

  echo "release-please-pr: FAIL (release-please exited ${release_please_status} and no open draft ${target_branch} release PR exists)" >&2
  exit "${release_please_status}"
fi

if use_existing_open_release_pr "release-please completed"; then
  exit 0
fi

echo "release-please-pr: PASS (release-please completed; no release PR needed for ${target_branch})"
