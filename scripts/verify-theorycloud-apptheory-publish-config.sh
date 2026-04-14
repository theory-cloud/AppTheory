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
  if ! grep -Fq "${needle}" <<<"${haystack}"; then
    fail "expected to find '${needle}'"
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
assert_equals "$(bash "${SCRIPT_DIR}/theorycloud-apptheory-env.sh" --source-s3-uri --stage lab)" "s3://kt-sources-lab-787107040121/theorycloud/apptheory/"
assert_equals "$(bash "${SCRIPT_DIR}/theorycloud-apptheory-env.sh" --source-s3-uri --stage live)" "s3://kt-sources-live-787107040121/theorycloud/apptheory/"
assert_equals "$(bash "${SCRIPT_DIR}/theorycloud-apptheory-env.sh" --publish-url --stage lab)" "https://l0lw87lsp1.execute-api.us-east-1.amazonaws.com/v1/internal/publish/theorycloud"
assert_equals "$(bash "${SCRIPT_DIR}/theorycloud-apptheory-env.sh" --publish-url --stage live)" "https://at3k47vix3.execute-api.us-east-1.amazonaws.com/v1/internal/publish/theorycloud"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

lab_sync_output="$(THEORYCLOUD_APPTHEORY_SOURCE_REVISION=abc123def456 THEORYCLOUD_S3_SYNC_DRY_RUN=true bash "${SCRIPT_DIR}/sync-theorycloud-apptheory-subtree.sh" --branch premain --output "${TMP_DIR}/lab")"
assert_contains "${lab_sync_output}" 'stage=lab'
assert_contains "${lab_sync_output}" 'branch=premain'
assert_contains "${lab_sync_output}" 'destination=s3://kt-sources-lab-787107040121/theorycloud/apptheory/'
assert_contains "${lab_sync_output}" 'delete=true'
assert_contains "${lab_sync_output}" 'command=aws s3 sync'

live_sync_output="$(THEORYCLOUD_APPTHEORY_SOURCE_REVISION=abc123def456 THEORYCLOUD_S3_SYNC_DRY_RUN=true bash "${SCRIPT_DIR}/sync-theorycloud-apptheory-subtree.sh" --branch main --output "${TMP_DIR}/live")"
assert_contains "${live_sync_output}" 'stage=live'
assert_contains "${live_sync_output}" 'branch=main'
assert_contains "${live_sync_output}" 'destination=s3://kt-sources-live-787107040121/theorycloud/apptheory/'
assert_contains "${live_sync_output}" 'delete=true'

lab_publish_output="$(THEORYCLOUD_PUBLISH_DRY_RUN=true bash "${SCRIPT_DIR}/trigger-theorycloud-publish.sh" --branch premain --source-revision abc123def456 --idempotency-key test-lab)"
assert_contains "${lab_publish_output}" 'stage=lab'
assert_contains "${lab_publish_output}" 'branch=premain'
assert_contains "${lab_publish_output}" 'url=https://l0lw87lsp1.execute-api.us-east-1.amazonaws.com/v1/internal/publish/theorycloud'
assert_contains "${lab_publish_output}" 'payload={"source_revision":"abc123def456","idempotency_key":"test-lab","reason":"docs sync complete","force":false}'

live_publish_output="$(THEORYCLOUD_PUBLISH_DRY_RUN=true bash "${SCRIPT_DIR}/trigger-theorycloud-publish.sh" --branch main --source-revision abc123def456 --idempotency-key test-live)"
assert_contains "${live_publish_output}" 'stage=live'
assert_contains "${live_publish_output}" 'branch=main'
assert_contains "${live_publish_output}" 'url=https://at3k47vix3.execute-api.us-east-1.amazonaws.com/v1/internal/publish/theorycloud'
assert_contains "${live_publish_output}" 'payload={"source_revision":"abc123def456","idempotency_key":"test-live","reason":"docs sync complete","force":false}'

echo 'verify-theorycloud-apptheory-publish-config: PASS'
