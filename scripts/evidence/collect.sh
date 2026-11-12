#!/usr/bin/env bash
# Purpose: collect reviewed validation evidence for approved gates.
#
# The collector executes only the command IDs in
# scripts/evidence/validation-gates.json, records their real exit codes, and
# binds the exact working-tree inputs they ran against. It refuses a dirty tree,
# and it refuses to publish a PASS when inputs changed during the run.
#
# Usage:
#   scripts/evidence/collect.sh --gate <gate-id> [--review-ref <ref>]...
#   scripts/evidence/collect.sh --all [--review-ref <ref>]...
#   scripts/evidence/collect.sh --all --dry-run
#   scripts/evidence/collect.sh --all --force   # explicit re-execution override
#
# Collection is incremental: --all enumerates the required coverage and runs
# only missing/failed/stale/affected gates. A second unchanged run executes zero
# commands. Completed records are written atomically per gate, so an interrupted
# run keeps its completed proof and a restart resumes only the unfinished work.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

exec python3 scripts/evidence/validation_evidence.py collect "$@"
