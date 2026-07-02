#!/usr/bin/env bash
# Purpose: smoke-test the SSR-only provided-assets site example output.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

need_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "ssr-only-provided-assets-smoke: BLOCKED (${cmd} not found)" >&2
    exit 1
  fi
}

for cmd in aws curl node npm python3; do
  need_cmd "${cmd}"
done

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "ssr-only-provided-assets-smoke: BLOCKED (AWS credentials not configured)" >&2
  exit 1
fi

example_dir="examples/cdk/ssr-only-provided-assets-site"
stack_name_raw="${APPTHEORY_SSR_ONLY_PROVIDED_ASSETS_STACK_NAME:-AppTheorySsrOnlyProvidedAssetsSmoke-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}}"
stack_name="$(printf '%s' "${stack_name_raw}" | tr -cd '[:alnum:]-')"
if [[ -z "${stack_name}" || ! "${stack_name}" =~ ^[A-Za-z] ]]; then
  stack_name="AppTheorySsrOnlyProvidedAssetsSmoke-${stack_name}"
fi

keep_stack="${KEEP_STACK:-${APPTHEORY_SSR_ONLY_PROVIDED_ASSETS_KEEP_STACK:-0}}"
outputs_file="$(mktemp)"
headers_file="$(mktemp)"
body_file="$(mktemp)"
deploy_attempted="0"
deployed="0"

cleanup() {
  local exit_code=$?

  if [[ "${deploy_attempted}" == "1" && "${keep_stack}" != "1" ]]; then
    if aws cloudformation describe-stacks --stack-name "${stack_name}" >/dev/null 2>&1; then
      (
        cd "${example_dir}"
        APPTHEORY_SSR_ONLY_PROVIDED_ASSETS_STACK_NAME="${stack_name}" \
          npx cdk destroy "${stack_name}" --force >/dev/null
      ) || {
        echo "ssr-only-provided-assets-smoke: WARN (failed to destroy ${stack_name})" >&2
        if [[ "${exit_code}" -eq 0 ]]; then
          exit_code=1
        fi
      }
    fi
  elif [[ "${deployed}" == "1" ]]; then
    echo "ssr-only-provided-assets-smoke: KEEP (${stack_name})"
  fi

  rm -f "${outputs_file}" "${headers_file}" "${body_file}"
  exit "${exit_code}"
}
trap cleanup EXIT

extract_output() {
  local key="$1"
  python3 - "${outputs_file}" "${stack_name}" "${key}" <<'PY'
import json
import sys

path, stack_name, key = sys.argv[1:4]
data = json.load(open(path, encoding="utf-8"))
stack_outputs = data.get(stack_name) or {}
value = stack_outputs.get(key, "")
print(str(value).strip())
PY
}

expect_request_id_echo() {
  local request_id="$1"
  python3 - "${headers_file}" "${request_id}" <<'PY'
import sys

headers_path, expected = sys.argv[1:3]
for line in open(headers_path, encoding="utf-8", errors="replace"):
    if line.lower().startswith("x-request-id:"):
        observed = line.split(":", 1)[1].strip()
        if observed == expected:
            sys.exit(0)
print(f"missing x-request-id echo for {expected}", file=sys.stderr)
sys.exit(1)
PY
}

probe_contains() {
  local url="$1"
  local expected_status="$2"
  local needle="$3"
  local request_id="$4"
  local attempts="${5:-40}"
  local sleep_seconds="${6:-15}"

  local attempt=1
  local status=""
  while [[ "${attempt}" -le "${attempts}" ]]; do
    status="$(curl -sS -H "x-request-id: ${request_id}" -D "${headers_file}" -o "${body_file}" --max-time 30 "${url}" -w '%{http_code}' || true)"

    if [[ "${status}" == "${expected_status}" ]] && grep -Fq -- "${needle}" "${body_file}"; then
      if expect_request_id_echo "${request_id}" >/dev/null 2>&1; then
        return 0
      fi
    fi

    if [[ "${attempt}" -lt "${attempts}" ]]; then
      sleep "${sleep_seconds}"
    fi
    attempt=$((attempt + 1))
  done

  echo "ssr-only-provided-assets-smoke: FAIL (url=${url} status=${status:-curl-error})" >&2
  echo "ssr-only-provided-assets-smoke: headers" >&2
  cat "${headers_file}" >&2 || true
  echo "ssr-only-provided-assets-smoke: body" >&2
  cat "${body_file}" >&2 || true
  exit 1
}

probe_s3_origin_4xx() {
  local url="$1"
  local request_id="$2"
  local attempts="${3:-20}"
  local sleep_seconds="${4:-10}"

  local attempt=1
  local status=""
  while [[ "${attempt}" -le "${attempts}" ]]; do
    status="$(curl -sS -H "x-request-id: ${request_id}" -D "${headers_file}" -o "${body_file}" --max-time 30 "${url}" -w '%{http_code}' || true)"

    if [[ "${status}" == "403" || "${status}" == "404" ]]; then
      return 0
    fi

    if [[ "${attempt}" -lt "${attempts}" ]]; then
      sleep "${sleep_seconds}"
    fi
    attempt=$((attempt + 1))
  done

  echo "ssr-only-provided-assets-smoke: FAIL (url=${url} expected S3-origin 403/404, got ${status:-curl-error})" >&2
  echo "ssr-only-provided-assets-smoke: headers" >&2
  cat "${headers_file}" >&2 || true
  echo "ssr-only-provided-assets-smoke: body" >&2
  cat "${body_file}" >&2 || true
  exit 1
}

deploy_attempted="1"
(
  cd "${example_dir}"
  npm ci >/dev/null
  APPTHEORY_SSR_ONLY_PROVIDED_ASSETS_STACK_NAME="${stack_name}" \
    npx cdk deploy "${stack_name}" --require-approval never --outputs-file "${outputs_file}" >/dev/null
)
deployed="1"

cloudfront_url="$(extract_output "CloudFrontUrl")"
distribution_id="$(extract_output "CloudFrontDistributionId")"
asset_bucket_name="$(extract_output "AssetsBucketName")"
known_js_path="$(extract_output "KnownJsAssetPath")"
known_css_path="$(extract_output "KnownCssAssetPath")"
known_text_path="$(extract_output "KnownTextAssetPath")"

if [[ -z "${cloudfront_url}" || -z "${distribution_id}" || -z "${asset_bucket_name}" ]]; then
  echo "ssr-only-provided-assets-smoke: FAIL (missing expected outputs from ${stack_name})" >&2
  cat "${outputs_file}" >&2 || true
  exit 1
fi

request_id="apptheory-provided-assets-${stack_name}-$$"
request_id="$(printf '%s' "${request_id}" | tr -cd '[:alnum:]._-' | cut -c1-120)"

probe_contains "${cloudfront_url}" "200" "AppTheory SSR_ONLY provided assets" "${request_id}-html" 40 15
probe_contains "${cloudfront_url%/}${known_js_path}" "200" "AppTheory SSR_ONLY provided assets validation" "${request_id}-js" 20 10
probe_contains "${cloudfront_url%/}${known_css_path}" "200" "--apptheory-validation-accent" "${request_id}-css" 20 10
probe_contains "${cloudfront_url%/}${known_text_path}" "200" "apptheory-ssr-only-provided-assets" "${request_id}-txt" 20 10
probe_s3_origin_4xx "${cloudfront_url%/}/assets" "${request_id}-assets-direct" 20 10

echo "ssr-only-provided-assets-smoke: PASS (stack=${stack_name} distribution=${distribution_id} assets_bucket=${asset_bucket_name})"
