#!/usr/bin/env bash
# Purpose: let a composed check reuse another gate's verified evidence.
#
# The collector exports APPTHEORY_EVIDENCE_REUSE with the gate ids whose records
# the current command may consume. This helper verifies the named record against
# the exact candidate inputs (it never executes a recorded command) and exits 0
# only when the proof is applicable. Any failure exits 1 so the caller executes
# its real command; missing, stale, mismatched, failed or unknown proof never
# becomes success by omission.
#
# The helper appends one tab-separated line to APPTHEORY_EVIDENCE_CONSUME_LOG
# when set, which the collector records as explicit coverage attribution.
#
# Usage (from a leaf command): reuse-if-recorded.sh <gate-id>
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"

gate="${1:-}"
if [[ ! "${gate}" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  exit 1
fi

# A forced execution environment (runtime floors, generated delta) must never
# consume another environment's proof.
if [[ "${EVIDENCE_FORCE_EXECUTE:-}" == "true" ]]; then
  exit 1
fi

reuse="${APPTHEORY_EVIDENCE_REUSE:-}"
case ",${reuse}," in
  *",${gate},"*) ;;
  *) exit 1 ;;
esac

stderr_file="$(mktemp)"
trap 'rm -f "${stderr_file}"' EXIT

if ! python3 scripts/evidence/validation_evidence.py verify --gate "${gate}" >/dev/null 2>"${stderr_file}"; then
  reason="$(tail -n 1 "${stderr_file}" | sed -e 's/^validation-evidence: FAIL (//' -e 's/)$//')"
  echo "evidence-consume: gate=${gate} not-applicable (${reason:-no applicable record})" >&2
  exit 1
fi

line="$(
  python3 - "${gate}" <<'PY'
import json
import sys
from pathlib import Path

gate = sys.argv[1]
root = Path.cwd()
registry = json.loads((root / "scripts/evidence/validation-gates.json").read_text(encoding="utf-8"))
record_path = root / registry["evidenceDirectory"] / f"{gate}.json"
record = json.loads(record_path.read_text(encoding="utf-8"))
scope = record.get("scope") or {}
print(f"gate={gate}\tdigest={scope.get('digest', '')}\trecordedAt={record.get('recordedAt', '')}")
PY
)"

echo "evidence-consume: ${line//$'\t'/ }" >&2
if [[ -n "${APPTHEORY_EVIDENCE_CONSUME_LOG:-}" ]]; then
  printf '%s\n' "${line}" >>"${APPTHEORY_EVIDENCE_CONSUME_LOG}"
fi
exit 0
