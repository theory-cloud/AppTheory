#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "BLOCKED: missing required tool for timestamp regression test: python3" >&2
  exit 2
fi

# Source only the timestamp/report helpers from the production verifier. The
# verifier refuses helper-only mode when executed directly, so this cannot be
# used as a rubric bypass.
GOV_RUBRIC_TIMESTAMP_HELPER_ONLY=1 source "${SCRIPT_DIR}/gov-verify-rubric.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local message="$3"

  if [[ "${actual}" != "${expected}" ]]; then
    fail "${message}: expected '${expected}', got '${actual}'"
  fi
}

assert_report_json_has_only_timestamp() {
  local timestamp="$1"
  local expected="$2"
  local rendered

  rendered="{\"timestamp\":\"$(json_escape "${timestamp}")\"}"
  REPORT_JSON="${rendered}" python3 - "${expected}" <<'PY'
import json
import os
import sys

expected = sys.argv[1]
doc = json.loads(os.environ["REPORT_JSON"])
if list(doc.keys()) != ["timestamp"]:
    raise SystemExit(f"unexpected keys: {list(doc.keys())}")
if doc["timestamp"] != expected:
    raise SystemExit(f"timestamp mismatch: {doc['timestamp']!r} != {expected!r}")
PY
}

write_report_with_timestamp() {
  local path="$1"
  local timestamp="$2"

  REPORT_TIMESTAMP_VALUE="${timestamp}" python3 - "${path}" <<'PY'
import json
import os
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(
    json.dumps({"timestamp": os.environ["REPORT_TIMESTAMP_VALUE"]}),
    encoding="utf-8",
)
PY
}

tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

fallback_timestamp="2026-05-30T00:00:00Z"
valid_env_timestamp="2026-05-30T12:34:56Z"
valid_existing_timestamp="2026-05-29T12:34:56Z"
malicious_timestamp=$'2026-05-30T12:34:56Z",\n  "injected": true,\n  "timestamp": "1999-01-01T00:00:00Z'

if ! is_valid_report_timestamp "${valid_env_timestamp}"; then
  fail "valid UTC seconds timestamp was rejected"
fi
if is_valid_report_timestamp "${malicious_timestamp}"; then
  fail "malicious timestamp was accepted"
fi
if is_valid_report_timestamp "2026-02-30T12:34:56Z"; then
  fail "invalid calendar timestamp was accepted"
fi
if is_valid_report_timestamp "2026-05-30T12:34:56+00:00"; then
  fail "offset timestamp was accepted"
fi

selected="$(select_report_timestamp_value "${valid_env_timestamp}" "${malicious_timestamp}" "${fallback_timestamp}")"
assert_eq "${valid_env_timestamp}" "${selected}" "valid GOV_REPORT_TIMESTAMP should win"

selected="$(select_report_timestamp_value "${malicious_timestamp}" "" "${fallback_timestamp}")"
assert_eq "${fallback_timestamp}" "${selected}" "malicious GOV_REPORT_TIMESTAMP should fall back"
assert_report_json_has_only_timestamp "${selected}" "${fallback_timestamp}"

malicious_report="${tmpdir}/malicious-report.json"
write_report_with_timestamp "${malicious_report}" "${malicious_timestamp}"
existing_timestamp="$(read_existing_report_timestamp "${malicious_report}")"
assert_eq "${malicious_timestamp}" "${existing_timestamp}" "existing timestamp fixture read failed"
selected="$(select_report_timestamp_value "" "${existing_timestamp}" "${fallback_timestamp}")"
assert_eq "${fallback_timestamp}" "${selected}" "malicious existing report timestamp should fall back"
assert_report_json_has_only_timestamp "${selected}" "${fallback_timestamp}"

valid_report="${tmpdir}/valid-report.json"
write_report_with_timestamp "${valid_report}" "${valid_existing_timestamp}"
existing_timestamp="$(read_existing_report_timestamp "${valid_report}")"
selected="$(select_report_timestamp_value "" "${existing_timestamp}" "${fallback_timestamp}")"
assert_eq "${valid_existing_timestamp}" "${selected}" "valid existing report timestamp should be preserved"

corrupt_report="${tmpdir}/corrupt-report.json"
printf '{"timestamp": "2026-05-30T12:34:56Z",' > "${corrupt_report}"
existing_timestamp="$(read_existing_report_timestamp "${corrupt_report}" 2>/dev/null || true)"
assert_eq "" "${existing_timestamp}" "corrupt existing report should not provide a timestamp"

# Defense-in-depth: even a raw malicious value must render as a single JSON
# string field if it reaches the JSON writer.
assert_report_json_has_only_timestamp "${malicious_timestamp}" "${malicious_timestamp}"

if ! grep -Fq '  "timestamp": "$(json_escape "$REPORT_TIMESTAMP")",' "${SCRIPT_DIR}/gov-verify-rubric.sh"; then
  fail "production report writer is not using json_escape for the timestamp"
fi

echo "gov-rubric timestamp regression: PASS"
