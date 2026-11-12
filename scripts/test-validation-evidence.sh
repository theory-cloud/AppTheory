#!/usr/bin/env bash
# Purpose: negative and positive controls for the validation-evidence producer
# and verifier. Every case runs the real scripts against a throwaway git
# repository; nothing is mocked at the entry point.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python_bin="${PYTHON:-python3}"
evidence_py="${repo_root}/scripts/evidence/validation_evidence.py"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/apptheory-validation-evidence.XXXXXX")"
trap 'rm -rf "${tmp}"' EXIT

scratch="${tmp}/repo"
registry="${tmp}/registry.json"
mkdir -p "${scratch}/evidence" "${scratch}/gen"

cat >"${registry}" <<'JSON'
{
  "schemaVersion": 1,
  "evidenceDirectory": "evidence",
  "localLogDirectory": "evidence/local",
  "clockSkewSeconds": 300,
  "securityMaxAgeSeconds": 86400,
  "releaseOnly": {
    "exact": ["VERSION", "artifact.txt"],
    "prefixes": [],
    "patterns": ["gen/*"]
  },
  "securityInputs": {
    "exact": ["deps.lock"],
    "patterns": []
  },
  "gates": {
    "unit": {
      "kind": "source",
      "environment": "toolchain",
      "commands": [{"id": "unit", "argv": ["true"]}]
    },
    "broken": {
      "kind": "source",
      "environment": "toolchain",
      "commands": [{"id": "broken", "argv": ["false"]}]
    },
    "mutator": {
      "kind": "source",
      "environment": "toolchain",
      "commands": [{"id": "mutator", "argv": ["bash", "-c", "echo mutation >> src.txt"]}]
    },
    "scan": {
      "kind": "dependency-scan",
      "environment": "toolchain",
      "maxAgeSeconds": 86400,
      "commands": [{"id": "scan", "argv": ["true"]}]
    },
    "noop": {
      "kind": "source",
      "environment": "toolchain",
      "commands": [{"id": "noop", "argv": ["true"]}]
    }
  }
}
JSON

init_repo() {
  (
    cd "${scratch}"
    git init -q -b main
    git config user.name "validation-evidence self-test"
    git config user.email "validation-evidence@example.invalid"
    git config commit.gpgsign false
    printf 'one\n' >src.txt
    printf '1.0.0\n' >VERSION
    printf 'version=1.0.0\n' >artifact.txt
    printf 'gen 1.0.0\n' >gen/a.txt
    printf 'dep\n' >deps.lock
    printf 'keep\n' >evidence/.gitkeep
    git add -A
    git commit -q -m "fix: seed"
  )
}

collect() {
  "${python_bin}" "${evidence_py}" --registry "${registry}" collect --root "${scratch}" "$@"
}

verify() {
  "${python_bin}" "${evidence_py}" --registry "${registry}" verify --root "${scratch}" "$@"
}

pass_count=0
expect_ok() {
  local label="$1"
  shift
  if ! "$@" >"${tmp}/out.log" 2>&1; then
    echo "test-validation-evidence: FAIL (${label})" >&2
    cat "${tmp}/out.log" >&2
    exit 1
  fi
  pass_count=$((pass_count + 1))
  echo "test-validation-evidence: PASS ${label}"
}

expect_fail() {
  local label="$1"
  shift
  if "$@" >"${tmp}/out.log" 2>&1; then
    echo "test-validation-evidence: FAIL (${label}; command unexpectedly passed)" >&2
    cat "${tmp}/out.log" >&2
    exit 1
  fi
  pass_count=$((pass_count + 1))
  echo "test-validation-evidence: PASS ${label}"
}

expect_output() {
  local label="$1"
  local needle="$2"
  shift 2
  if ! "$@" >"${tmp}/out.log" 2>&1; then
    echo "test-validation-evidence: FAIL (${label})" >&2
    cat "${tmp}/out.log" >&2
    exit 1
  fi
  if ! grep -Fq -- "${needle}" "${tmp}/out.log"; then
    echo "test-validation-evidence: FAIL (${label}; missing ${needle})" >&2
    cat "${tmp}/out.log" >&2
    exit 1
  fi
  pass_count=$((pass_count + 1))
  echo "test-validation-evidence: PASS ${label}"
}

commit_all() {
  (
    cd "${scratch}"
    git add -A
    git commit -q -m "$1"
  )
}

init_repo
mkdir -p "${scratch}/scripts/evidence"
cp "${evidence_py}" "${scratch}/scripts/evidence/validation_evidence.py"
cp "${registry}" "${scratch}/scripts/evidence/validation-gates.json"
cp "${repo_root}/scripts/evidence/verify-or-execute.sh" "${scratch}/scripts/evidence/verify-or-execute.sh"
commit_all "fix: install the evidence entry point for wrapper tests"


# 1. Positive control: real collection then verification.
expect_ok "collect source gate" collect --gate unit
expect_output "verify identical inputs" "mode=evidence-verified" verify --gate unit

# 0. The real wrapper reuses verified proof, executes when none applies, and
#    forces execution for an untrusted pull-request origin.
expect_output "wrapper reuses applicable evidence" "evidence-verified" \
  env GOTOOLCHAIN=go1.27.4 bash -c 'cd "$1" && bash scripts/evidence/verify-or-execute.sh --gate unit' _ "${scratch}"
expect_output "wrapper executes when no evidence applies" "executing" \
  env GOTOOLCHAIN=go1.27.4 bash -c 'cd "$1" && bash scripts/evidence/verify-or-execute.sh --gate noop' _ "${scratch}"
printf '{"pull_request":{"head":{"repo":{"full_name":"someone-else/AppTheory"}}}}\n' >"${tmp}/fork-event.json"
fork_status=0
fork_output="$(
  cd "${scratch}" &&
    GOTOOLCHAIN=go1.27.4 GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH="${tmp}/fork-event.json" GITHUB_REPOSITORY=theory-cloud/AppTheory \
      bash scripts/evidence/verify-or-execute.sh --gate unit --verify-only 2>&1
)" || fork_status=$?
if [[ "${fork_status:-0}" -eq 0 || "${fork_output}" != *"would-execute"* ]]; then
  echo "test-validation-evidence: FAIL (a fork PR must never reuse evidence)" >&2
  echo "${fork_output}" >&2
  exit 1
fi
pass_count=$((pass_count + 1))
echo "test-validation-evidence: PASS fork PR forces execution"

# 2. Same tree, different commit SHA.
(
  cd "${scratch}"
  git commit -q --allow-empty -m "fix: empty commit proves SHA independence"
)
expect_ok "verify same tree after an empty commit" verify --gate unit

# 3. Evidence-only additions do not invalidate source identity.
printf '{"note":"reviewer inspected the logs"}\n' >"${scratch}/evidence/review-note.json"
commit_all "fix: add evidence-only review note"
expect_ok "verify after an evidence-only commit" verify --gate unit

# 4. Final-edit mutation after collection.
printf 'two\n' >>"${scratch}/src.txt"
expect_fail "verify rejects a final edit" verify --gate unit
(
  cd "${scratch}"
  git checkout -q -- src.txt
)
expect_ok "verify recovers when the source returns" verify --gate unit

# 5. Missing evidence record.
mv "${scratch}/evidence/unit.json" "${tmp}/unit.json.bak"
expect_fail "verify rejects missing evidence" verify --gate unit
mv "${tmp}/unit.json.bak" "${scratch}/evidence/unit.json"

# 6. Failed verdicts are retained honestly and never read as success.
expect_fail "collect retains a failing command" collect --gate broken
grep -Fq '"verdict": "FAIL"' "${scratch}/evidence/broken.json" ||
  {
    echo "test-validation-evidence: FAIL (failed record was not retained)" >&2
    exit 1
  }
expect_fail "verify rejects a recorded failure" verify --gate broken

# 7. Inputs changed during the run.
expect_fail "collect detects a during-run edit" collect --gate mutator
grep -Fq "changed during the run" "${scratch}/evidence/mutator.json" ||
  {
    echo "test-validation-evidence: FAIL (during-run edit was not recorded)" >&2
    exit 1
  }
(
  cd "${scratch}"
  git checkout -q -- src.txt
)
rm -f "${scratch}/evidence/mutator.json"

# 8. Malformed record, future timestamp, unapproved command, environment drift.
cp "${scratch}/evidence/unit.json" "${tmp}/unit.json.good"
printf '{not json\n' >"${scratch}/evidence/unit.json"
expect_fail "verify rejects malformed JSON" verify --gate unit

"${python_bin}" - "${scratch}/evidence/unit.json" "${tmp}/unit.json.good" <<'PY'
import json
import sys
from pathlib import Path

source = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
source["recordedAt"] = "2999-01-01T00:00:00Z"
Path(sys.argv[1]).write_text(json.dumps(source), encoding="utf-8")
PY
expect_fail "verify rejects a future record timestamp" verify --gate unit

"${python_bin}" - "${scratch}/evidence/unit.json" "${tmp}/unit.json.good" <<'PY'
import json
import sys
from pathlib import Path

source = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
source["commands"][0]["argv"] = ["bash", "-c", "touch pwned"]
Path(sys.argv[1]).write_text(json.dumps(source), encoding="utf-8")
PY
expect_fail "verify rejects an unapproved command" verify --gate unit
if [[ -e "${scratch}/pwned" || -e "${repo_root}/pwned" ]]; then
  echo "test-validation-evidence: FAIL (the verifier executed a recorded command)" >&2
  exit 1
fi
pass_count=$((pass_count + 1))
echo "test-validation-evidence: PASS verifier never executes recorded commands"

"${python_bin}" - "${scratch}/evidence/unit.json" "${tmp}/unit.json.good" <<'PY'
import json
import sys
from pathlib import Path

source = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
source["environment"]["go"] = "go0.0.0"
Path(sys.argv[1]).write_text(json.dumps(source), encoding="utf-8")
PY
expect_fail "verify rejects an environment mismatch" verify --gate unit

cp "${tmp}/unit.json.good" "${scratch}/evidence/unit.json"
expect_ok "verify recovers the good record" verify --gate unit

# 9. Release-only version substitution is applicable; any other generated edit is not.
printf '1.1.0\n' >"${scratch}/VERSION"
printf 'version=1.1.0\n' >"${scratch}/artifact.txt"
printf 'gen 1.1.0\n' >"${scratch}/gen/a.txt"
commit_all "fix: release 1.1.0"
expect_output "verify accepts a pure version substitution" "mode=release-transformation-verified" verify --gate unit
cp "${scratch}/gen/a.txt" "${tmp}/gen-a.txt.bak"
printf 'extra source smuggled into a generated path\n' >>"${scratch}/gen/a.txt"
commit_all "fix: smuggle a generated edit"
expect_fail "verify rejects a non-version generated edit" verify --gate unit
cp "${tmp}/gen-a.txt.bak" "${scratch}/gen/a.txt"
commit_all "fix: restore the generated artifact"
expect_output "verify accepts the restored generated artifact" "mode=release-transformation-verified" verify --gate unit

# 10. A source edit is never mistaken for a release-only transformation.
cp "${scratch}/src.txt" "${tmp}/src.txt.bak2"
printf 'runtime change\n' >>"${scratch}/src.txt"
commit_all "fix: source change"
expect_fail "verify rejects a source change" verify --gate unit
cp "${tmp}/src.txt.bak2" "${scratch}/src.txt"
commit_all "fix: restore the source"
expect_output "verify returns to the release transformation" "mode=release-transformation-verified" verify --gate unit

# 11. Dirty tree refusal and missing relevant input.
printf 'dirty\n' >"${scratch}/dirty.txt"
expect_fail "collect refuses a dirty tree" collect --gate unit
rm -f "${scratch}/dirty.txt"
mv "${scratch}/src.txt" "${tmp}/src.txt.bak"
expect_fail "verify rejects a missing relevant input" verify --gate unit
mv "${tmp}/src.txt.bak" "${scratch}/src.txt"

# 12. Dependency freshness: fresh passes, stale and future fail.
expect_ok "collect dependency scan" collect --gate scan
expect_ok "verify fresh dependency scan" verify --gate scan
cp "${scratch}/evidence/scan.json" "${tmp}/scan.json.good"
"${python_bin}" - "${scratch}/evidence/scan.json" "${tmp}/scan.json.good" <<'PY'
import json
import sys
from pathlib import Path

source = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
source["scan"]["scannedAt"] = "2020-01-01T00:00:00Z"
Path(sys.argv[1]).write_text(json.dumps(source), encoding="utf-8")
PY
expect_fail "verify rejects a stale dependency scan" verify --gate scan
"${python_bin}" - "${scratch}/evidence/scan.json" "${tmp}/scan.json.good" <<'PY'
import json
import sys
from pathlib import Path

source = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
source["scan"]["scannedAt"] = "2999-01-01T00:00:00Z"
Path(sys.argv[1]).write_text(json.dumps(source), encoding="utf-8")
PY
expect_fail "verify rejects a future dependency scan" verify --gate scan
"${python_bin}" - "${scratch}/evidence/scan.json" "${tmp}/scan.json.good" <<'PYMAXAGE'
import json
import sys
from pathlib import Path

source = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
source["scan"]["maxAgeSeconds"] = 31536000
Path(sys.argv[1]).write_text(json.dumps(source), encoding="utf-8")
PYMAXAGE
expect_fail "verify rejects a widened scan max age" verify --gate scan
cp "${tmp}/scan.json.good" "${scratch}/evidence/scan.json"
expect_ok "verify recovers the fresh dependency scan" verify --gate scan

# 13. Review finalization adds references without invalidating identity.
expect_ok "finalize adds review references" \
  "${python_bin}" "${evidence_py}" --registry "${registry}" finalize --root "${scratch}" --gate unit --review-ref factory-review-1
expect_output "finalized record still verifies" "reviews=factory-review-1" verify --gate unit

echo "test-validation-evidence: PASS (${pass_count} checks)"
