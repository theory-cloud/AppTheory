#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() {
  echo "verify-theorycloud-apptheory-publish-config: FAIL ($*)" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  if ! grep -Fq -- "${needle}" <<<"${haystack}"; then
    fail "expected to find '${needle}'"
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  if grep -Fq -- "${needle}" <<<"${haystack}"; then
    fail "did not expect to find '${needle}'"
  fi
}

assert_not_has_line() {
  local haystack="$1"
  local needle="$2"
  if grep -Fxq -- "${needle}" <<<"${haystack}"; then
    fail "did not expect to find line '${needle}'"
  fi
}

assert_equals() {
  local actual="$1"
  local expected="$2"
  if [[ "${actual}" != "${expected}" ]]; then
    fail "expected '${expected}' but got '${actual}'"
  fi
}

assert_equals "$(bash "${SCRIPT_DIR}/theorycloud-apptheory-env.sh" --stage-for-branch premain)" "lab"
assert_equals "$(bash "${SCRIPT_DIR}/theorycloud-apptheory-env.sh" --stage-for-branch main)" "live"
assert_equals "$(THEORYCLOUD_STAGE=lab bash "${SCRIPT_DIR}/theorycloud-apptheory-env.sh" --resolve-stage --branch main)" "lab"
assert_equals "$(THEORYCLOUD_STAGE=live bash "${SCRIPT_DIR}/theorycloud-apptheory-env.sh" --resolve-stage --branch premain)" "live"
assert_equals "$(bash "${SCRIPT_DIR}/theorycloud-apptheory-env.sh" --source-s3-uri --stage lab)" "s3://kt-sources-lab-787107040121/theorycloud/apptheory/"
assert_equals "$(bash "${SCRIPT_DIR}/theorycloud-apptheory-env.sh" --source-s3-uri --stage live)" "s3://kt-sources-live-787107040121/theorycloud/apptheory/"
assert_equals "$(bash "${SCRIPT_DIR}/theorycloud-apptheory-env.sh" --publish-url --stage lab)" "https://l0lw87lsp1.execute-api.us-east-1.amazonaws.com/v1/internal/publish/theorycloud"
assert_equals "$(bash "${SCRIPT_DIR}/theorycloud-apptheory-env.sh" --publish-url --stage live)" "https://at3k47vix3.execute-api.us-east-1.amazonaws.com/v1/internal/publish/theorycloud"

run_with_branch_stage_resolution() {
  env -u THEORYCLOUD_STAGE "$@"
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

lab_sync_output="$(run_with_branch_stage_resolution THEORYCLOUD_APPTHEORY_SOURCE_REVISION=abc123def456 THEORYCLOUD_S3_SYNC_DRY_RUN=true bash "${SCRIPT_DIR}/sync-theorycloud-apptheory-subtree.sh" --branch premain --output "${TMP_DIR}/lab")"
assert_contains "${lab_sync_output}" 'stage=lab'
assert_contains "${lab_sync_output}" 'branch=premain'
assert_contains "${lab_sync_output}" 'destination=s3://kt-sources-lab-787107040121/theorycloud/apptheory/'
assert_contains "${lab_sync_output}" 'delete=true'
assert_contains "${lab_sync_output}" 'command=aws s3 sync'

live_sync_output="$(run_with_branch_stage_resolution THEORYCLOUD_APPTHEORY_SOURCE_REVISION=abc123def456 THEORYCLOUD_S3_SYNC_DRY_RUN=true bash "${SCRIPT_DIR}/sync-theorycloud-apptheory-subtree.sh" --branch main --output "${TMP_DIR}/live")"
assert_contains "${live_sync_output}" 'stage=live'
assert_contains "${live_sync_output}" 'branch=main'
assert_contains "${live_sync_output}" 'destination=s3://kt-sources-live-787107040121/theorycloud/apptheory/'
assert_contains "${live_sync_output}" 'delete=true'

lab_publish_output="$(run_with_branch_stage_resolution THEORYCLOUD_PUBLISH_DRY_RUN=true bash "${SCRIPT_DIR}/trigger-theorycloud-publish.sh" --branch premain --source-revision abc123def456 --idempotency-key test-lab)"
assert_contains "${lab_publish_output}" 'stage=lab'
assert_contains "${lab_publish_output}" 'branch=premain'
assert_contains "${lab_publish_output}" 'url=https://l0lw87lsp1.execute-api.us-east-1.amazonaws.com/v1/internal/publish/theorycloud'
assert_contains "${lab_publish_output}" 'payload={"source_revision":"abc123def456","idempotency_key":"test-lab","reason":"docs sync complete","force":false}'
assert_contains "${lab_publish_output}" 'command=awscurl --service execute-api --region us-east-1 -X POST -H content-type: application/json --fail-with-body -o <response-file> --data'
assert_not_contains "${lab_publish_output}" "-w '%{http_code}'"

live_publish_output="$(run_with_branch_stage_resolution THEORYCLOUD_PUBLISH_DRY_RUN=true bash "${SCRIPT_DIR}/trigger-theorycloud-publish.sh" --branch main --source-revision abc123def456 --idempotency-key test-live)"
assert_contains "${live_publish_output}" 'stage=live'
assert_contains "${live_publish_output}" 'branch=main'
assert_contains "${live_publish_output}" 'url=https://at3k47vix3.execute-api.us-east-1.amazonaws.com/v1/internal/publish/theorycloud'
assert_contains "${live_publish_output}" 'payload={"source_revision":"abc123def456","idempotency_key":"test-live","reason":"docs sync complete","force":false}'
assert_contains "${live_publish_output}" 'command=awscurl --service execute-api --region us-east-1 -X POST -H content-type: application/json --fail-with-body -o <response-file> --data'
assert_not_contains "${live_publish_output}" "-w '%{http_code}'"

FAKE_AWSCURL_ARGS_LOG="${TMP_DIR}/awscurl-args.log"
mkdir -p "${TMP_DIR}/bin"
cat > "${TMP_DIR}/bin/awscurl" <<'EOF_AWSCURL'
#!/usr/bin/env bash
set -euo pipefail

args_log="${FAKE_AWSCURL_ARGS_LOG:?}"
output_file=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output)
      printf '%s\n' "$1" >> "${args_log}"
      output_file="$2"
      printf '%s\n' "${output_file}" >> "${args_log}"
      shift 2
      ;;
    *)
      printf '%s\n' "$1" >> "${args_log}"
      shift
      ;;
  esac
done

if [[ -z "${output_file}" ]]; then
  echo "missing -o output file" >&2
  exit 91
fi

printf '%s' '{"job_id":"fake-job","status":"enqueued"}' > "${output_file}"
EOF_AWSCURL
chmod +x "${TMP_DIR}/bin/awscurl"

live_publish_exec_output="$(run_with_branch_stage_resolution PATH="${TMP_DIR}/bin:${PATH}" FAKE_AWSCURL_ARGS_LOG="${FAKE_AWSCURL_ARGS_LOG}" THEORYCLOUD_PUBLISH_DRY_RUN=false bash "${SCRIPT_DIR}/trigger-theorycloud-publish.sh" --branch premain --source-revision abc123def456 --idempotency-key test-exec)"
live_publish_exec_args="$(cat "${FAKE_AWSCURL_ARGS_LOG}")"
assert_contains "${live_publish_exec_output}" 'trigger-theorycloud-publish: PASS (url=https://l0lw87lsp1.execute-api.us-east-1.amazonaws.com/v1/internal/publish/theorycloud)'
assert_contains "${live_publish_exec_output}" '{"job_id":"fake-job","status":"enqueued"}'
assert_contains "${live_publish_exec_args}" '--service'
assert_contains "${live_publish_exec_args}" 'execute-api'
assert_contains "${live_publish_exec_args}" '--region'
assert_contains "${live_publish_exec_args}" 'us-east-1'
assert_contains "${live_publish_exec_args}" '-X'
assert_contains "${live_publish_exec_args}" 'POST'
assert_contains "${live_publish_exec_args}" '-H'
assert_contains "${live_publish_exec_args}" 'content-type: application/json'
assert_contains "${live_publish_exec_args}" '--fail-with-body'
assert_contains "${live_publish_exec_args}" '-o'
assert_contains "${live_publish_exec_args}" '--data'
assert_contains "${live_publish_exec_args}" '{"source_revision":"abc123def456","idempotency_key":"test-exec","reason":"docs sync complete","force":false}'
assert_contains "${live_publish_exec_args}" 'https://l0lw87lsp1.execute-api.us-east-1.amazonaws.com/v1/internal/publish/theorycloud'
assert_not_has_line "${live_publish_exec_args}" "-w"

echo 'verify-theorycloud-apptheory-publish-config: PASS'
