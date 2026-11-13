#!/usr/bin/env bash
# Purpose: verify one gate's evidence against the candidate working tree.
#
# Verification never executes a command named by the evidence record. It
# recomputes the input projections and compares them with the tracked record.
# Exit 0 means the recorded proof is applicable to this exact input set.
#
# Usage: scripts/evidence/verify.sh --gate <gate-id> [--json]
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

exec python3 scripts/evidence/validation_evidence.py verify "$@"
