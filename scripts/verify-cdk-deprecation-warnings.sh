#!/usr/bin/env bash
# Purpose: verify CDK deprecation warnings remain intentional and documented.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

gate_name="cdk-deprecation-warnings"

if ! command -v node >/dev/null 2>&1; then
  echo "${gate_name}: BLOCKED (node not found)" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "${gate_name}: BLOCKED (npm not found)" >&2
  exit 1
fi
if [[ ! -d "cdk" ]]; then
  echo "${gate_name}: FAIL (missing cdk/)" >&2
  exit 1
fi

if ! (cd cdk && npm ci >/dev/null); then
  echo "${gate_name}: FAIL (cd cdk && npm ci failed)" >&2
  exit 1
fi

tmp_log="$(mktemp)"
cleanup() { rm -f "${tmp_log}"; }
trap cleanup EXIT

if ! (cd cdk && npm test) >"${tmp_log}" 2>&1; then
  echo "${gate_name}: FAIL (cd cdk && npm test failed)" >&2
  echo "${gate_name}: last 200 lines of npm test output:" >&2
  tail -n 200 "${tmp_log}" >&2 || true
  exit 1
fi

count_fixed() {
  local pattern="$1"
  { LC_ALL=C grep -F -o -- "${pattern}" "${tmp_log}" || true; } | wc -l | tr -d '[:space:]'
}

count_deprecation_terms() {
  { LC_ALL=C grep -E -i -o -- 'deprecated|deprecation' "${tmp_log}" || true; } | wc -l | tr -d '[:space:]'
}

print_excerpt() {
  local name="$1"
  local pattern="$2"
  echo "${gate_name}: excerpt for ${name} (${pattern}):" >&2
  { LC_ALL=C grep -n -F -C 2 -- "${pattern}" "${tmp_log}" || true; } | sed -n '1,80p' >&2
}

names=(
  "RestApiProps#minimumCompressionSize"
  "DnsValidatedCertificate"
  "GrantOnPrincipalOptions#scope"
)
patterns=(
  "RestApiProps#minimumCompressionSize"
  "DnsValidatedCertificate"
  "GrantOnPrincipalOptions#scope"
)

echo "${gate_name}: scanned command: cd cdk && npm test"

failure=0
counts=()
for i in "${!patterns[@]}"; do
  count="$(count_fixed "${patterns[$i]}")"
  counts+=("${count}")
  echo "${gate_name}: ${names[$i]} count: ${count}"
  if (( count > 0 )); then
    failure=1
  fi
done

generic_count="$(count_deprecation_terms)"
echo "${gate_name}: deprecated/deprecation count: ${generic_count}"

if (( failure != 0 )); then
  echo "${gate_name}: FAIL (deprecated CDK warning classes reappeared)" >&2
  for i in "${!patterns[@]}"; do
    if (( counts[$i] > 0 )); then
      print_excerpt "${names[$i]}" "${patterns[$i]}"
    fi
  done
  exit 1
fi

echo "${gate_name}: PASS"
