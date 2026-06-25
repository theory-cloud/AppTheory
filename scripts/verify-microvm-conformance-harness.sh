#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

python3 scripts/test_microvm_conformance.py
python3 scripts/microvm_conformance.py run \
  --config examples/microvm-conformance/equaltoai-host.config.example.json \
  --dry-run \
  --fixture examples/microvm-conformance/fixtures/no-leak-artifacts.json
python3 scripts/microvm_conformance.py scan \
  --artifact no-leak=examples/microvm-conformance/fixtures/scanner-no-leak-artifacts.json \
  --sensitive-value auth-token-DO-NOT-LOG-123456 \
  --sensitive-value provider-token-DO-NOT-LOG-123456

echo "microvm-conformance-harness: PASS"
