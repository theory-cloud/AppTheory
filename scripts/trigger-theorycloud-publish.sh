#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "${SCRIPT_DIR}/theorycloud-apptheory-env.sh"

usage() {
  cat <<'EOF_USAGE'
Usage:
  bash scripts/trigger-theorycloud-publish.sh [--stage STAGE] [--branch BRANCH] [--publish-url URL] [--source-revision SHA] [--idempotency-key KEY] [--reason TEXT] [--force]

Environment:
  THEORYCLOUD_STAGE           Optional explicit stage override
  THEORYCLOUD_BRANCH_NAME     Optional branch-name override for premain/main mapping
  THEORYCLOUD_PUBLISH_URL     Optional override for the publish endpoint URL
  KT_PUBLISH_URL              Alternate override for the publish endpoint URL
  THEORYCLOUD_PUBLISH_DRY_RUN Default: false. When true, print the request instead of invoking KT
  THEORYCLOUD_PUBLISH_REASON  Default: docs sync complete
  THEORYCLOUD_PUBLISH_FORCE   Default: false
  SOURCE_REVISION             Optional source revision override
  AWS_REGION                  Default: us-east-1
EOF_USAGE
}

fail() {
  echo "trigger-theorycloud-publish: FAIL ($*)" >&2
  exit 1
}

STAGE="${THEORYCLOUD_STAGE:-}"
BRANCH_NAME="${THEORYCLOUD_BRANCH_NAME:-}"
PUBLISH_URL="${THEORYCLOUD_PUBLISH_URL:-${KT_PUBLISH_URL:-}}"
SOURCE_REVISION="${SOURCE_REVISION:-}"
IDEMPOTENCY_KEY=""
REASON="${THEORYCLOUD_PUBLISH_REASON:-docs sync complete}"
FORCE="${THEORYCLOUD_PUBLISH_FORCE:-false}"
PUBLISH_DRY_RUN="${THEORYCLOUD_PUBLISH_DRY_RUN:-false}"
AWS_REGION="${AWS_REGION:-us-east-1}"

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
    --publish-url)
      PUBLISH_URL="$2"
      shift 2
      ;;
    --source-revision)
      SOURCE_REVISION="$2"
      shift 2
      ;;
    --idempotency-key)
      IDEMPOTENCY_KEY="$2"
      shift 2
      ;;
    --reason)
      REASON="$2"
      shift 2
      ;;
    --force)
      FORCE="true"
      shift
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
if [[ -z "${PUBLISH_URL}" ]]; then
  PUBLISH_URL="$(apptheory_theorycloud_publish_url_for_stage "${STAGE}" || true)"
fi
if [[ -z "${PUBLISH_URL}" ]]; then
  fail "missing publish URL for stage ${STAGE}"
fi
if [[ ! "${PUBLISH_URL}" =~ ^https:// ]]; then
  fail "publish URL must be https://...: ${PUBLISH_URL}"
fi

if [[ -z "${SOURCE_REVISION}" ]]; then
  SOURCE_REVISION="$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || true)"
fi
if [[ -z "${SOURCE_REVISION}" ]]; then
  fail "missing source revision"
fi

short_sha="${SOURCE_REVISION:0:12}"
if [[ -z "${IDEMPOTENCY_KEY}" ]]; then
  if [[ -n "${GITHUB_RUN_ID:-}" ]]; then
    IDEMPOTENCY_KEY="github-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT:-1}-${short_sha}"
  else
    IDEMPOTENCY_KEY="manual-${short_sha}"
  fi
fi

PAYLOAD="$(python3 - <<PY
import json
payload = {
  'source_revision': ${SOURCE_REVISION@Q},
  'idempotency_key': ${IDEMPOTENCY_KEY@Q},
  'reason': ${REASON@Q},
  'force': ${FORCE@Q}.lower() == 'true',
}
print(json.dumps(payload, separators=(',', ':')))
PY
)"

if [[ "${PUBLISH_DRY_RUN}" == "true" ]]; then
  echo "trigger-theorycloud-publish: DRY RUN"
  echo "stage=${STAGE}"
  if [[ -n "${BRANCH_NAME}" ]]; then
    echo "branch=${BRANCH_NAME}"
  fi
  echo "url=${PUBLISH_URL}"
  echo "payload=${PAYLOAD}"
  echo "command=curl --aws-sigv4 aws:amz:${AWS_REGION}:execute-api --user <sigv4-credentials> -H content-type: application/json -H x-amz-security-token: <aws-session-token> -X POST --fail-with-body -o <response-file> --data ${PAYLOAD} ${PUBLISH_URL}"
  echo "trigger-theorycloud-publish: PASS (dry-run; url=${PUBLISH_URL})"
  exit 0
fi

command -v curl >/dev/null 2>&1 || fail "curl is required for publish invocation"

AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-}"
AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-}"
AWS_SESSION_TOKEN="${AWS_SESSION_TOKEN:-}"

if [[ -z "${AWS_ACCESS_KEY_ID}" || -z "${AWS_SECRET_ACCESS_KEY}" ]]; then
  fail "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for publish invocation"
fi

response_file="$(mktemp)"
trap 'rm -f "${response_file}"' EXIT

curl_args=(
  --aws-sigv4 "aws:amz:${AWS_REGION}:execute-api"
  --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}"
  -X POST
  -H 'content-type: application/json'
  --fail-with-body
  --data "${PAYLOAD}"
  -o "${response_file}"
)

if [[ -n "${AWS_SESSION_TOKEN}" ]]; then
  curl_args+=(-H "x-amz-security-token: ${AWS_SESSION_TOKEN}")
fi

if curl "${curl_args[@]}" "${PUBLISH_URL}"; then
  :
else
  status=$?
  body="$(cat "${response_file}" 2>/dev/null || true)"
  fail "curl invocation failed for ${PUBLISH_URL} (exit ${status}): ${body}"
fi

body="$(cat "${response_file}")"
echo "trigger-theorycloud-publish: PASS (url=${PUBLISH_URL})"
printf '%s\n' "${body}"
rm -f "${response_file}"
trap - EXIT
