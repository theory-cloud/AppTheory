#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/theorycloud-apptheory-env.sh"

usage() {
  cat <<'EOF_USAGE'
Usage:
  bash scripts/sync-theorycloud-apptheory-subtree.sh [--stage STAGE] [--branch BRANCH] [--source-s3-uri URI] [--output DIR]

Environment:
  THEORYCLOUD_STAGE                          Optional explicit stage override
  THEORYCLOUD_BRANCH_NAME                    Optional branch-name override for premain/main mapping
  THEORYCLOUD_APPTHEORY_SUBTREE_OUTPUT_DIR   Staging root directory. Default: /tmp/apptheory-theorycloud
  THEORYCLOUD_APPTHEORY_SOURCE_S3_URI        Optional override for the subtree destination S3 URI
  KT_SOURCE_S3_URI                           Alternate override for the subtree destination S3 URI
  THEORYCLOUD_S3_SYNC_DELETE                 Default: true. When true, prune objects under theorycloud/apptheory/
  THEORYCLOUD_S3_SYNC_DRY_RUN                Default: false. When true, print the sync plan without calling AWS
EOF_USAGE
}

fail() {
  echo "sync-theorycloud-apptheory-subtree: FAIL ($*)" >&2
  exit 1
}

require_s3_uri() {
  local value="$1"
  local label="$2"
  if [[ -z "${value}" ]]; then
    fail "missing ${label}"
  fi
  if [[ "${value}" != s3://* ]]; then
    fail "${label} must be an s3:// URI: ${value}"
  fi
}

STAGE="${THEORYCLOUD_STAGE:-}"
BRANCH_NAME="${THEORYCLOUD_BRANCH_NAME:-}"
OUTPUT_DIR="${THEORYCLOUD_APPTHEORY_SUBTREE_OUTPUT_DIR:-/tmp/apptheory-theorycloud}"
SOURCE_S3_URI="${THEORYCLOUD_APPTHEORY_SOURCE_S3_URI:-${KT_SOURCE_S3_URI:-}}"
SYNC_DELETE="${THEORYCLOUD_S3_SYNC_DELETE:-true}"
SYNC_DRY_RUN="${THEORYCLOUD_S3_SYNC_DRY_RUN:-false}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)
      STAGE="$2"
      shift 2
      ;;
    --branch)
      BRANCH_NAME="$2"
      shift 2
      ;;
    --source-s3-uri)
      SOURCE_S3_URI="$2"
      shift 2
      ;;
    --output)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

STAGE="$(THEORYCLOUD_BRANCH_NAME="${BRANCH_NAME}" apptheory_theorycloud_resolve_stage "${STAGE}")"
if [[ -z "${SOURCE_S3_URI}" ]]; then
  SOURCE_S3_URI="$(apptheory_theorycloud_source_s3_uri_for_stage "${STAGE}" || true)"
fi
require_s3_uri "${SOURCE_S3_URI}" "THEORYCLOUD_APPTHEORY_SOURCE_S3_URI"
SOURCE_S3_URI="${SOURCE_S3_URI%/}/"

bash "${SCRIPT_DIR}/stage-theorycloud-apptheory-subtree.sh" --output "${OUTPUT_DIR}"

if [[ ! -f "${OUTPUT_DIR}/source-manifest.json" ]]; then
  fail "missing staged provenance manifest at ${OUTPUT_DIR}/source-manifest.json"
fi

sync_flags=()
if [[ "${SYNC_DELETE}" == "true" ]]; then
  sync_flags+=(--delete)
fi

if [[ "${SYNC_DRY_RUN}" == "true" ]]; then
  echo "sync-theorycloud-apptheory-subtree: DRY RUN"
  echo "stage=${STAGE}"
  if [[ -n "${BRANCH_NAME}" ]]; then
    echo "branch=${BRANCH_NAME}"
  fi
  echo "source=${OUTPUT_DIR%/}/"
  echo "destination=${SOURCE_S3_URI}"
  if [[ "${SYNC_DELETE}" == "true" ]]; then
    echo "delete=true"
  else
    echo "delete=false"
  fi
  echo "command=aws s3 sync ${OUTPUT_DIR%/}/ ${SOURCE_S3_URI} ${sync_flags[*]:-}"
  echo "sync-theorycloud-apptheory-subtree: PASS (dry-run; target=${SOURCE_S3_URI})"
  exit 0
fi

command -v aws >/dev/null 2>&1 || fail "aws CLI is required"

echo "syncing AppTheory subtree to ${SOURCE_S3_URI}"
if ! aws s3 sync "${OUTPUT_DIR%/}/" "${SOURCE_S3_URI}" "${sync_flags[@]}"; then
  fail "aws s3 sync failed for ${SOURCE_S3_URI}"
fi

echo "sync-theorycloud-apptheory-subtree: PASS (target=${SOURCE_S3_URI})"
