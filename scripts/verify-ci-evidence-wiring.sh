#!/usr/bin/env bash
# Purpose: fail closed when the evidence-aware CI wiring drifts from the tracked
# gate registry: a job that may reuse proof must keep its verify-or-execute entry
# point, a job whose environment is itself under test must keep forcing
# execution, and the always-executing release/security job must never gain an
# evidence entry point.
#
# The classification is delegated to cmd/ci-guard, which parses the workflows as
# YAML and reads the tracked registry; matching raw text would let a renamed gate
# or a second unconditional step pass.
#
# Exit codes: 0 PASS, 1 FAIL, 2 BLOCKED.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v go >/dev/null 2>&1; then
  echo "ci-evidence-wiring: BLOCKED (go toolchain not found; cmd/ci-guard reads the registry)" >&2
  exit 2
fi

go run ./cmd/ci-guard evidence-wiring --root "$(pwd)"
