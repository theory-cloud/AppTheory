#!/usr/bin/env bash
# Purpose: reuse applicable validation evidence, otherwise execute the gate.
#
# This is the CI entry point. It never turns missing, stale, mismatched, failed
# or unapproved proof into success: any verification failure falls back to
# executing the approved command set from the tracked registry. A pull request
# whose head repository is not this repository always executes, so untrusted
# content gains nothing from carrying evidence records.
#
# A gate is verified against a tracked proof profile, not against the runner's
# own environment. CI is an evidence verifier; the record names the real
# environment its commands ran in. A runtime-floor leg passes its profile so the
# same tested environment is reused on every later release event instead of
# being forced to execute again.
#
# When the requested profile has no applicable record, the gate's tracked
# fallback profiles (for example its Linux producer for a platform-bound claim)
# are verified before executing. A record is always labeled with the profile
# that really produced it, and the printed line names both the verified profile
# and the requested one.
#
# Execution goes through the collector's own record builder: it writes the
# completed record atomically for the real producing environment, keeps FAIL and
# tainted results honest, and refuses a profile the live host cannot truthfully
# produce. When APPTHEORY_EVIDENCE_PRODUCED_MANIFEST is set, each record the run
# wrote is listed there so the workflow can upload the produced files instead of
# a glob over the checkout.
#
# The printed line and the job summary state unambiguously which profile was
# verified or executed.
#
# Usage: scripts/evidence/verify-or-execute.sh --gate <gate-id> [--profile <id>] [--verify-only]
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"

gate=""
profile=""
verify_only=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --gate)
      gate="${2:-}"
      shift 2
      ;;
    --profile)
      profile="${2:-}"
      shift 2
      ;;
    --verify-only)
      verify_only=true
      shift
      ;;
    --help|-h)
      cat <<'USAGE'
usage: scripts/evidence/verify-or-execute.sh --gate <gate-id> [--profile <id>] [--verify-only]

Reuses a verified evidence record for the gate and tracked proof profile, or
executes its approved commands and records the real producing environment.
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

profile_args=()
if [[ -n "${profile}" ]]; then
  profile_args=(--profile "${profile}")
fi

describe_target() {
  if [[ -n "${profile}" ]]; then
    printf '%s (profile %s)' "${gate}" "${profile}"
  else
    printf '%s (default profile)' "${gate}"
  fi
}

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
  if python3 scripts/evidence/validation_evidence.py verify --gate "${gate}" "${profile_args[@]}" 2>"${verify_stderr}"; then
    cat "${verify_stderr}" >&2 || true
    echo "gate $(describe_target): evidence-verified (no command executed in this run)"
    summary_line "- \`${gate}\`: evidence-verified for its tracked proof profile (reused reviewed local proof; not executed in this run)"
    exit 0
  fi
  reason="$(tail -n 1 "${verify_stderr}" | sed -e 's/^validation-evidence: FAIL (//' -e 's/)$//')"
  cat "${verify_stderr}" >&2 || true

  # A gate may declare tracked producing fallbacks (for example the Linux CI
  # producer of a platform-bound build claim). Verify those records too: the
  # verifier compares the record with its tracked profile and never with its
  # own runner, so a macOS-produced record still verifies on a Linux verifier,
  # and a Linux-produced fallback record verifies under its own profile name.
  profile_plan="$(
    python3 - "${gate}" "${profile}" <<'PY'
import json
import sys
from pathlib import Path

gate, profile = sys.argv[1], sys.argv[2]
registry = json.loads(Path("scripts/evidence/validation-gates.json").read_text(encoding="utf-8"))
entry = registry.get("gates", {}).get(gate, {})
allowed = [str(item) for item in entry.get("profiles") or ["default"]]
requested = profile or allowed[0]
print(requested)
for item in entry.get("fallbackProfiles", []):
    if str(item) != requested:
        print(str(item))
PY
  )" || profile_plan=""
  requested_profile_id="$(printf '%s\n' "${profile_plan}" | sed -n '1p')"
  while IFS= read -r candidate; do
    if [[ -z "${candidate}" ]]; then
      continue
    fi
    fallback_stderr="$(mktemp)"
    if python3 scripts/evidence/validation_evidence.py verify --gate "${gate}" --profile "${candidate}" 2>"${fallback_stderr}"; then
      cat "${fallback_stderr}" >&2 || true
      rm -f "${fallback_stderr}"
      echo "gate ${gate} (profile ${candidate}; requested ${requested_profile_id}): evidence-verified (tracked fallback profile; no command executed in this run)"
      summary_line "- \`${gate}\`: evidence-verified via tracked fallback profile \`${candidate}\` for requested \`${requested_profile_id}\` (no command executed in this run)"
      exit 0
    fi
    cat "${fallback_stderr}" >&2 || true
    rm -f "${fallback_stderr}"
  done < <(printf '%s\n' "${profile_plan}" | sed -n '2,$p')

  # A gate may declare that another gate's record fully covers its command set
  # (for example the deterministic-build record covers the standalone ts/py
  # packaging smoke). Verify that record too; anything else still executes.
  composed_from="$(
    python3 - "${gate}" <<'PY'
import json
import sys
from pathlib import Path

gate = sys.argv[1]
registry = json.loads(Path("scripts/evidence/validation-gates.json").read_text(encoding="utf-8"))
entry = registry.get("gates", {}).get(gate, {})
print("\n".join(str(item) for item in entry.get("composedFrom", [])))
PY
  )" || composed_from=""
  while IFS= read -r dependency; do
    if [[ -z "${dependency}" ]]; then
      continue
    fi
    dependency_stderr="$(mktemp)"
    if python3 scripts/evidence/validation_evidence.py verify --gate "${dependency}" "${profile_args[@]}" 2>"${dependency_stderr}"; then
      cat "${dependency_stderr}" >&2 || true
      rm -f "${dependency_stderr}"
      echo "gate $(describe_target): evidence-verified (composed from ${dependency}; no command executed in this run)"
      summary_line "- \`${gate}\`: evidence-verified via \`${dependency}\` (no command executed in this run)"
      exit 0
    fi
    cat "${dependency_stderr}" >&2 || true
    rm -f "${dependency_stderr}"
  done <<<"${composed_from}"
else
  reason="untrusted pull-request origin or forced execution"
fi

if [[ "${verify_only}" == "true" ]]; then
  echo "gate $(describe_target): would-execute (${reason:-no applicable evidence})"
  summary_line "- \`${gate}\`: would execute (${reason:-no applicable evidence})"
  exit 1
fi

echo "gate $(describe_target): executing (${reason:-no applicable evidence})"
summary_line "- \`${gate}\`: executed in this run (${reason:-no applicable evidence})"
exec python3 scripts/evidence/validation_evidence.py run --gate "${gate}" "${profile_args[@]}" --forced
