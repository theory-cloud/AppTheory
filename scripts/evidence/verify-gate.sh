#!/usr/bin/env bash
# Purpose: verify one gate's tracked evidence record against the candidate tree.
#
# This is the CI entry point, and it verifies only. CI never executes a gate:
# gates are verified once, on the pull request into staging, from a record the
# steward produced locally. A record is applicable when the recorded input
# digests, the tracked proof profile and the gate's approved command set all
# match this exact tree. A missing, stale, mismatched or failed record fails the
# job with the command that produces one locally.
#
# A gate may declare tracked fallback profiles (for example the Linux producer
# of a platform-bound claim) and composed gates whose record fully covers its
# command set. Both are verified the same way, under their own tracked profile
# name, and the printed line names which one satisfied the job.
#
# Fork pull requests are not special-cased: a fork cannot carry a record
# produced here, so it fails closed like any other untrusted origin. External
# contributions arrive through a pre-arranged branch negotiated with
# CODEOWNERS, and a codeowner carries the change into staging with local
# evidence.
#
# Exit codes: 0 the record applies to this tree; 1 no applicable record.
#
# Usage: scripts/evidence/verify-gate.sh --gate <gate-id> [--profile <id>]
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"

gate=""
profile=""
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
    --help|-h)
      cat <<'USAGE'
usage: scripts/evidence/verify-gate.sh --gate <gate-id> [--profile <id>]

Verifies the gate's reviewed evidence record for the requested tracked proof
profile, then its declared fallback profiles, then its composed gates. Nothing
is executed: when no record applies, this prints the local collection command
and exits 1.
USAGE
      exit 0
      ;;
    *)
      echo "verify-gate: FAIL (unknown argument: $1)" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${gate}" ]]; then
  echo "verify-gate: FAIL (--gate is required)" >&2
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

summary_line() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$1" >>"${GITHUB_STEP_SUMMARY}"
  fi
}

registry_query() {
  python3 - "${gate}" "${profile}" <<'PY'
import json
import sys
from pathlib import Path

gate, profile = sys.argv[1], sys.argv[2]
registry = json.loads(Path("scripts/evidence/validation-gates.json").read_text(encoding="utf-8"))
entry = registry.get("gates", {}).get(gate, {})
requested = profile or str((entry.get("profiles") or ["default"])[0])
print("requested\t" + requested)
for fallback in entry.get("fallbackProfiles", []):
    if str(fallback) != requested:
        print("fallback\t" + str(fallback))
gates = registry.get("gates", {})
for composed in entry.get("composedFrom", []):
    # A composed gate is only a candidate when it declares the requested
    # profile. Asking a default-only producer to verify a floor profile would
    # replace the real reason (no record for this tree) with a profile error.
    supported = [str(item) for item in (gates.get(str(composed)) or {}).get("profiles") or ["default"]]
    if requested in supported:
        print("composed\t" + str(composed))
PY
}

plan="$(registry_query)" || plan=""
requested_profile_id="$(printf '%s\n' "${plan}" | awk -F'\t' '$1 == "requested" { print $2 }')"
if [[ -z "${requested_profile_id}" ]]; then
  requested_profile_id="${profile:-default}"
fi

verify_stderr="$(mktemp)"
trap 'rm -f "${verify_stderr}"' EXIT

if python3 scripts/evidence/validation_evidence.py verify --gate "${gate}" --profile "${requested_profile_id}" 2>"${verify_stderr}"; then
  cat "${verify_stderr}" >&2 || true
  echo "gate $(describe_target): evidence-verified (no command executed in this run)"
  summary_line "- \`${gate}\`: evidence-verified for its tracked proof profile (reused reviewed local proof; not executed in this run)"
  exit 0
fi
reason="$(tail -n 1 "${verify_stderr}" | sed -e 's/^validation-evidence: FAIL (//' -e 's/)$//')"
cat "${verify_stderr}" >&2 || true

while IFS=$'\t' read -r kind candidate; do
  [[ "${kind}" == "fallback" && -n "${candidate}" ]] || continue
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
done < <(printf '%s\n' "${plan}" | awk -F'\t' '$1 == "fallback"')

while IFS=$'\t' read -r kind dependency; do
  [[ "${kind}" == "composed" && -n "${dependency}" ]] || continue
  dependency_stderr="$(mktemp)"
  if python3 scripts/evidence/validation_evidence.py verify --gate "${dependency}" --profile "${requested_profile_id}" 2>"${dependency_stderr}"; then
    cat "${dependency_stderr}" >&2 || true
    rm -f "${dependency_stderr}"
    echo "gate $(describe_target): evidence-verified (composed from ${dependency}; no command executed in this run)"
    summary_line "- \`${gate}\`: evidence-verified via \`${dependency}\` (no command executed in this run)"
    exit 0
  fi
  cat "${dependency_stderr}" >&2 || true
  rm -f "${dependency_stderr}"
done < <(printf '%s\n' "${plan}" | awk -F'\t' '$1 == "composed"')

echo "gate $(describe_target): no applicable evidence record (${reason:-no applicable record})" >&2
echo "produce evidence locally: run 'scripts/evidence/collect.sh --gate ${gate} --profile ${requested_profile_id}' on this tree and commit the record it writes; CI verifies records and never executes a gate" >&2
summary_line "- \`${gate}\`: FAILED, no applicable evidence record for \`${requested_profile_id}\`; produce evidence locally"
exit 1
