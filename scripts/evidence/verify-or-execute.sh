#!/usr/bin/env bash
# Purpose: reuse applicable validation evidence, otherwise execute the gate.
#
# This is the CI entry point. It never turns missing, stale, mismatched, failed
# or unapproved proof into success: any verification failure falls back to
# executing the approved command set from the tracked registry. A pull request
# whose head repository is not this repository always executes, so untrusted
# content gains nothing from carrying evidence records.
#
# The printed line and the job summary state unambiguously whether this run
# reused evidence or executed the commands.
#
# Usage: scripts/evidence/verify-or-execute.sh --gate <gate-id>
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"

gate=""
verify_only=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --gate)
      gate="${2:-}"
      shift 2
      ;;
    --verify-only)
      verify_only=true
      shift
      ;;
    --help|-h)
      cat <<'USAGE'
usage: scripts/evidence/verify-or-execute.sh --gate <gate-id> [--verify-only]

Reuses a verified evidence record for the gate or executes its approved commands.
--verify-only reports the decision and exits 0 only when evidence is reusable;
it never executes. Set EVIDENCE_FORCE_EXECUTE=true to force execution.
USAGE
      exit 0
      ;;
    *)
      echo "validation-evidence: FAIL (unknown argument: $1)" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${gate}" ]]; then
  echo "validation-evidence: FAIL (--gate is required)" >&2
  exit 1
fi

force_execute=false
if [[ "${EVIDENCE_FORCE_EXECUTE:-}" == "true" ]]; then
  force_execute=true
fi

if [[ "${force_execute}" != "true" && "${GITHUB_EVENT_NAME:-}" == "pull_request" && -n "${GITHUB_EVENT_PATH:-}" && -f "${GITHUB_EVENT_PATH}" ]]; then
  head_repository="$(
    python3 - "${GITHUB_EVENT_PATH}" <<'PY'
import json
import sys
from pathlib import Path

try:
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    print("unavailable")
    raise SystemExit(0)
print(data.get("pull_request", {}).get("head", {}).get("repo", {}).get("full_name", "unavailable"))
PY
  )"
  if [[ "${head_repository}" == "unavailable" ]]; then
    force_execute=true
  elif [[ -n "${GITHUB_REPOSITORY:-}" && "${head_repository}" != "${GITHUB_REPOSITORY}" ]]; then
    force_execute=true
  fi
fi

summary_line() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$1" >>"${GITHUB_STEP_SUMMARY}"
  fi
}

verify_stderr="$(mktemp)"
trap 'rm -f "${verify_stderr}"' EXIT

if [[ "${force_execute}" != "true" ]]; then
  if python3 scripts/evidence/validation_evidence.py verify --gate "${gate}" 2>"${verify_stderr}"; then
    cat "${verify_stderr}" >&2 || true
    echo "gate ${gate}: evidence-verified (no command executed in this run)"
    summary_line "- \`${gate}\`: evidence-verified (reused reviewed local proof; not executed in this run)"
    exit 0
  fi
  reason="$(tail -n 1 "${verify_stderr}" | sed -e 's/^validation-evidence: FAIL (//' -e 's/)$//')"
  cat "${verify_stderr}" >&2 || true
else
  reason="untrusted pull-request origin or forced execution"
fi

if [[ "${verify_only}" == "true" ]]; then
  echo "gate ${gate}: would-execute (${reason:-no applicable evidence})"
  summary_line "- \`${gate}\`: would execute (${reason:-no applicable evidence})"
  exit 1
fi

echo "gate ${gate}: executing (${reason:-no applicable evidence})"
summary_line "- \`${gate}\`: executed in this run (${reason:-no applicable evidence})"
exec python3 scripts/evidence/validation_evidence.py run --gate "${gate}"