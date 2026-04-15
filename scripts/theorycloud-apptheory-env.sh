#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

theorycloud_apptheory_env_fail() {
  echo "theorycloud-apptheory-env: FAIL ($*)" >&2
  exit 1
}

apptheory_theorycloud_stage_for_branch() {
  local branch="${1:-}"
  branch="${branch#refs/heads/}"
  case "${branch}" in
    premain) printf '%s\n' 'lab' ;;
    main) printf '%s\n' 'live' ;;
    *) return 1 ;;
  esac
}

apptheory_theorycloud_source_s3_uri_for_stage() {
  local stage="${1:-}"
  case "${stage}" in
    lab) printf '%s\n' 's3://kt-sources-lab-787107040121/theorycloud/apptheory/' ;;
    live) printf '%s\n' 's3://kt-sources-live-787107040121/theorycloud/apptheory/' ;;
    *) return 1 ;;
  esac
}

apptheory_theorycloud_publish_url_for_stage() {
  local stage="${1:-}"
  case "${stage}" in
    lab) printf '%s\n' 'https://l0lw87lsp1.execute-api.us-east-1.amazonaws.com/v1/internal/publish/theorycloud' ;;
    live) printf '%s\n' 'https://at3k47vix3.execute-api.us-east-1.amazonaws.com/v1/internal/publish/theorycloud' ;;
    *) return 1 ;;
  esac
}

apptheory_theorycloud_branch_name() {
  if [[ -n "${THEORYCLOUD_BRANCH_NAME:-}" ]]; then
    printf '%s\n' "${THEORYCLOUD_BRANCH_NAME}"
    return 0
  fi
  if [[ -n "${GITHUB_REF_NAME:-}" ]]; then
    printf '%s\n' "${GITHUB_REF_NAME}"
    return 0
  fi
  git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || true
}

apptheory_theorycloud_resolve_stage() {
  local stage="${1:-${THEORYCLOUD_STAGE:-}}"
  if [[ -n "${stage}" ]]; then
    stage="${stage,,}"
    case "${stage}" in
      lab|live)
        printf '%s\n' "${stage}"
        return 0
        ;;
      *)
        theorycloud_apptheory_env_fail "unsupported stage '${stage}' (expected lab or live)"
        ;;
    esac
  fi

  local branch
  branch="$(apptheory_theorycloud_branch_name)"
  if [[ -n "${branch}" ]]; then
    if stage="$(apptheory_theorycloud_stage_for_branch "${branch}" 2>/dev/null)"; then
      printf '%s\n' "${stage}"
      return 0
    fi
  fi

  printf '%s\n' 'lab'
}

theorycloud_apptheory_env_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash scripts/theorycloud-apptheory-env.sh --resolve-stage [--stage STAGE] [--branch BRANCH]
  bash scripts/theorycloud-apptheory-env.sh --stage-for-branch BRANCH
  bash scripts/theorycloud-apptheory-env.sh --source-s3-uri [--stage STAGE] [--branch BRANCH]
  bash scripts/theorycloud-apptheory-env.sh --publish-url [--stage STAGE] [--branch BRANCH]

Environment:
  THEORYCLOUD_STAGE        Optional explicit stage override
  THEORYCLOUD_BRANCH_NAME  Optional branch-name override for premain/main mapping
EOF_USAGE
}

theorycloud_apptheory_env_main() {
  local command=""
  local stage_arg=""
  local branch_arg=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --resolve-stage)
        command="resolve-stage"
        shift
        ;;
      --stage-for-branch)
        command="stage-for-branch"
        branch_arg="$2"
        shift 2
        ;;
      --source-s3-uri)
        command="source-s3-uri"
        shift
        ;;
      --publish-url)
        command="publish-url"
        shift
        ;;
      --stage)
        stage_arg="$2"
        shift 2
        ;;
      --branch)
        branch_arg="$2"
        shift 2
        ;;
      -h|--help)
        theorycloud_apptheory_env_usage
        exit 0
        ;;
      *)
        echo "unknown argument: $1" >&2
        theorycloud_apptheory_env_usage >&2
        exit 1
        ;;
    esac
  done

  case "${command}" in
    resolve-stage)
      THEORYCLOUD_BRANCH_NAME="${branch_arg}" apptheory_theorycloud_resolve_stage "${stage_arg}"
      ;;
    stage-for-branch)
      apptheory_theorycloud_stage_for_branch "${branch_arg}" ||
        theorycloud_apptheory_env_fail "unsupported branch '${branch_arg}'"
      ;;
    source-s3-uri)
      local resolved_stage
      resolved_stage="$(THEORYCLOUD_BRANCH_NAME="${branch_arg}" apptheory_theorycloud_resolve_stage "${stage_arg}")"
      apptheory_theorycloud_source_s3_uri_for_stage "${resolved_stage}" ||
        theorycloud_apptheory_env_fail "unsupported stage '${resolved_stage}'"
      ;;
    publish-url)
      local resolved_stage
      resolved_stage="$(THEORYCLOUD_BRANCH_NAME="${branch_arg}" apptheory_theorycloud_resolve_stage "${stage_arg}")"
      apptheory_theorycloud_publish_url_for_stage "${resolved_stage}" ||
        theorycloud_apptheory_env_fail "unsupported stage '${resolved_stage}'"
      ;;
    *)
      theorycloud_apptheory_env_usage >&2
      exit 1
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  theorycloud_apptheory_env_main "$@"
fi
