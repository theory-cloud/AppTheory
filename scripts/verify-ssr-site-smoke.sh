#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

need_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "ssr-site-smoke: BLOCKED (${cmd} not found)" >&2
    exit 1
  fi
}

for cmd in aws curl node npm python3; do
  need_cmd "${cmd}"
done

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "ssr-site-smoke: BLOCKED (AWS credentials not configured)" >&2
  exit 1
fi

example_dir="examples/cdk/ssr-site"
stack_name_raw="${APPTHEORY_SSR_SITE_STACK_NAME:-AppTheorySsrSiteSmoke-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}}"
stack_name="$(printf '%s' "${stack_name_raw}" | tr -cd '[:alnum:]-')"
if [[ -z "${stack_name}" || ! "${stack_name}" =~ ^[A-Za-z] ]]; then
  stack_name="AppTheorySsrSiteSmoke-${stack_name}"
fi

keep_stack="${APPTHEORY_SSR_SMOKE_KEEP_STACK:-0}"
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
        APPTHEORY_SSR_SITE_STACK_NAME="${stack_name}" npx cdk destroy "${stack_name}" --force >/dev/null
      ) || {
        echo "ssr-site-smoke: WARN (failed to destroy ${stack_name})" >&2
        if [[ "${exit_code}" -eq 0 ]]; then
          exit_code=1
        fi
      }
    fi
  elif [[ "${deployed}" == "1" ]]; then
    echo "ssr-site-smoke: KEEP (${stack_name})"
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

probe_contains() {
  local url="$1"
  local expected_status="$2"
  local needle="$3"
  local expect_request_id="$4"
  local attempts="${5:-40}"
  local sleep_seconds="${6:-15}"

  local attempt=1
  while [[ "${attempt}" -le "${attempts}" ]]; do
    local status
    status="$(curl -sS -D "${headers_file}" -o "${body_file}" --max-time 30 "${url}" -w '%{http_code}' || true)"

    if [[ "${status}" == "${expected_status}" ]] && grep -Fq "${needle}" "${body_file}"; then
      if [[ "${expect_request_id}" != "1" || "$(grep -ic '^x-request-id:' "${headers_file}")" -ge 1 ]]; then
        return 0
      fi
    fi

    if [[ "${attempt}" -lt "${attempts}" ]]; then
      sleep "${sleep_seconds}"
    fi
    attempt=$((attempt + 1))
  done

  echo "ssr-site-smoke: FAIL (url=${url} status=${status:-curl-error})" >&2
  echo "ssr-site-smoke: headers" >&2
  cat "${headers_file}" >&2 || true
  echo "ssr-site-smoke: body" >&2
  cat "${body_file}" >&2 || true
  exit 1
}

probe_exact_trimmed() {
  local url="$1"
  local expected_status="$2"
  local expected_body="$3"
  local expect_request_id="$4"
  local attempts="${5:-20}"
  local sleep_seconds="${6:-10}"

  local attempt=1
  while [[ "${attempt}" -le "${attempts}" ]]; do
    local status
    status="$(curl -sS -D "${headers_file}" -o "${body_file}" --max-time 30 "${url}" -w '%{http_code}' || true)"
    local trimmed_body
    trimmed_body="$(tr -d '\r\n' < "${body_file}")"

    if [[ "${status}" == "${expected_status}" && "${trimmed_body}" == "${expected_body}" ]]; then
      if [[ "${expect_request_id}" != "1" || "$(grep -ic '^x-request-id:' "${headers_file}")" -ge 1 ]]; then
        return 0
      fi
    fi

    if [[ "${attempt}" -lt "${attempts}" ]]; then
      sleep "${sleep_seconds}"
    fi
    attempt=$((attempt + 1))
  done

  echo "ssr-site-smoke: FAIL (url=${url} status=${status:-curl-error})" >&2
  echo "ssr-site-smoke: headers" >&2
  cat "${headers_file}" >&2 || true
  echo "ssr-site-smoke: body" >&2
  cat "${body_file}" >&2 || true
  exit 1
}

probe_status() {
  local url="$1"
  local expected_status="$2"
  local attempts="${3:-10}"
  local sleep_seconds="${4:-5}"

  local attempt=1
  while [[ "${attempt}" -le "${attempts}" ]]; do
    local status
    status="$(curl -sS -D "${headers_file}" -o "${body_file}" --max-time 30 "${url}" -w '%{http_code}' || true)"
    if [[ "${status}" == "${expected_status}" ]]; then
      return 0
    fi

    if [[ "${attempt}" -lt "${attempts}" ]]; then
      sleep "${sleep_seconds}"
    fi
    attempt=$((attempt + 1))
  done

  echo "ssr-site-smoke: FAIL (url=${url} expected status ${expected_status}, got ${status:-curl-error})" >&2
  echo "ssr-site-smoke: headers" >&2
  cat "${headers_file}" >&2 || true
  echo "ssr-site-smoke: body" >&2
  cat "${body_file}" >&2 || true
  exit 1
}

deploy_attempted="1"
(
  cd "${example_dir}"
  npm ci >/dev/null
  APPTHEORY_SSR_SITE_STACK_NAME="${stack_name}" \
    npx cdk deploy "${stack_name}" --require-approval never --outputs-file "${outputs_file}" >/dev/null
)
deployed="1"

cloudfront_url="$(extract_output "CloudFrontUrl")"
distribution_id="$(extract_output "CloudFrontDistributionId")"
ssr_function_url="$(extract_output "SsrFunctionUrl")"

if [[ -z "${cloudfront_url}" || -z "${distribution_id}" || -z "${ssr_function_url}" ]]; then
  echo "ssr-site-smoke: FAIL (missing expected outputs from ${stack_name})" >&2
  cat "${outputs_file}" >&2 || true
  exit 1
fi

probe_contains "${cloudfront_url}" "200" "Hello from AppTheory SSR Site" "1" 40 15
probe_exact_trimmed "${cloudfront_url%/}/assets/hello.txt" "200" "hello" "1" 20 10
probe_status "${ssr_function_url}" "403" 10 5

echo "ssr-site-smoke: PASS (stack=${stack_name} distribution=${distribution_id})"
