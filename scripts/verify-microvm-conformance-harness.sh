#!/usr/bin/env bash
# Purpose: verify the MicroVM consumer conformance harness and dry-run fixtures.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

python3 scripts/test_microvm_conformance.py
python3 scripts/microvm_conformance.py run \
  --config examples/microvm-conformance/equaltoai-host.config.example.json \
  --dry-run \
  --fixture examples/microvm-conformance/fixtures/no-leak-artifacts.json
python3 scripts/microvm_conformance.py scan \
  --artifact no-leak=examples/microvm-conformance/fixtures/scanner-no-leak-artifacts.json \
  --sensitive-value auth-token-DO-NOT-LOG-123456 \
  --sensitive-value provider-token-DO-NOT-LOG-123456

session_token_leak="$tmpdir/session-token-plaintext-leak.json"
session_token_scan_output="$tmpdir/session-token-plaintext-scan.out"
cat >"$session_token_leak" <<'JSON'
{"response":{"command":"auth-token","session_token_plaintext":"session-token-DO-NOT-LOG-123456"}}
JSON
if python3 scripts/microvm_conformance.py scan \
  --artifact session-token-plaintext="$session_token_leak" \
  >"$session_token_scan_output" 2>&1; then
  echo "microvm-conformance-harness: FAIL (session_token_plaintext scan unexpectedly passed)" >&2
  exit 1
fi
if grep -q "session-token-DO-NOT-LOG-123456" "$session_token_scan_output"; then
  echo "microvm-conformance-harness: FAIL (session_token_plaintext leaked in failure output)" >&2
  exit 1
fi
grep -q "session_token_plaintext" "$session_token_scan_output"

echo "microvm-conformance-harness: PASS"
