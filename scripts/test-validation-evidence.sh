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
  "runner": {"maxWorkers": 2, "resources": {"cpu": 2, "repo-write": 1, "docker": 1, "network": 1}},
  "nonProductPaths": ["docs/", "notes/", "scripts/", "bin/"],
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
      "resource": "cpu",
      "paths": ["src.txt", "VERSION", "artifact.txt", "gen/*"],
      "commands": [{"id": "unit", "argv": ["true"]}]
    },
    "broken": {
      "kind": "source",
      "environment": "toolchain",
      "resource": "cpu",
      "paths": ["src.txt"],
      "commands": [{"id": "broken", "argv": ["false"]}]
    },
    "mutator": {
      "kind": "source",
      "environment": "toolchain",
      "resource": "cpu",
      "paths": ["src.txt"],
      "commands": [{"id": "mutator", "argv": ["bash", "-c", "echo mutation >> src.txt"]}]
    },
    "scan": {
      "kind": "dependency-scan",
      "environment": "toolchain",
      "resource": "network",
      "maxAgeSeconds": 86400,
      "paths": ["deps.lock"],
      "commands": [{"id": "scan", "argv": ["true"]}]
    },
    "noop": {
      "kind": "source",
      "environment": "toolchain",
      "resource": "cpu",
      "paths": ["src.txt"],
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
cp "${repo_root}/scripts/evidence/reuse-if-recorded.sh" "${scratch}/scripts/evidence/reuse-if-recorded.sh"
cp "${repo_root}/scripts/evidence/collect.sh" "${scratch}/scripts/evidence/collect.sh"
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

# ---------------------------------------------------------------------------
# Scheduler semantics. Every case runs the real collector against a throwaway
# git repository with cheap fixture commands. These are scheduler proofs, not
# product proof.
# ---------------------------------------------------------------------------

sched="${tmp}/sched"
mkdir -p "${sched}/bin" "${sched}/scripts/evidence" "${sched}/evidence/state" "${sched}/docs"
for dir in alpha beta m x dep-parent dep-child shared fail fast slow prod-a prod-b inc-a inc-b; do
  mkdir -p "${sched}/src/${dir}"
  printf 'keep\n' >"${sched}/src/${dir}/keep.txt"
done
printf 'alpha seed\n' >"${sched}/src/alpha/x.txt"
printf 'inc-a seed\n' >"${sched}/src/inc-a/x.txt"
printf 'inc-b seed\n' >"${sched}/src/inc-b/x.txt"
printf 'note\n' >"${sched}/docs/note.md"
printf 'evidence\n' >"${sched}/evidence/.gitkeep"

cat >"${sched}/bin/job.py" <<'PYJOB'
import fcntl
import json
import os
import subprocess
import sys
import time
from pathlib import Path

MODE = sys.argv[1]
STATE = Path("evidence/state")
STATE.mkdir(parents=True, exist_ok=True)


def append(path, line):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


if MODE == "overlap":
    name, peer = sys.argv[2], sys.argv[3]
    (STATE / f"{name}.started").write_text("1", encoding="utf-8")
    deadline = time.time() + 10
    while not (STATE / f"{peer}.started").exists():
        if time.time() > deadline:
            print(f"overlap timeout: {name} never saw {peer}", file=sys.stderr)
            sys.exit(1)
        time.sleep(0.02)
    append(STATE / "runs.log", name)
    (STATE / f"{name}.done").write_text("1", encoding="utf-8")
elif MODE == "maxworkers":
    counter = Path(sys.argv[2])
    with counter.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        handle.seek(0)
        data = json.loads(handle.read() or '{"current": 0, "max": 0}')
        data["current"] += 1
        data["max"] = max(data["max"], data["current"])
        handle.seek(0)
        handle.truncate()
        json.dump(data, handle)
        handle.flush()
        os.fsync(handle.fileno())
        fcntl.flock(handle, fcntl.LOCK_UN)
    time.sleep(0.4)
    with counter.open("r+", encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        handle.seek(0)
        data = json.loads(handle.read())
        data["current"] -= 1
        handle.seek(0)
        handle.truncate()
        json.dump(data, handle)
        handle.flush()
        os.fsync(handle.fileno())
        fcntl.flock(handle, fcntl.LOCK_UN)
elif MODE == "exclusive":
    lock = Path(sys.argv[2])
    try:
        os.mkdir(lock)
    except FileExistsError:
        print("exclusive resource overlapped", file=sys.stderr)
        sys.exit(9)
    time.sleep(0.4)
    os.rmdir(lock)
elif MODE == "mark":
    append(sys.argv[2], "run")
elif MODE == "dep":
    if not Path(sys.argv[2]).exists():
        print("dependency record/marker missing", file=sys.stderr)
        sys.exit(7)
    append(STATE / "dep-child.log", "run")
elif MODE == "shared":
    append(sys.argv[2], "shared")
elif MODE == "sleepjob":
    Path(sys.argv[2]).write_text(str(os.getpid()), encoding="utf-8")
    time.sleep(float(sys.argv[3]))
elif MODE == "consume":
    for gate in sys.argv[2:]:
        completed = subprocess.run(["bash", "scripts/evidence/reuse-if-recorded.sh", gate], check=False)
        if completed.returncode != 0:
            print(f"compose failed for {gate}", file=sys.stderr)
            sys.exit(8)
    append(STATE / "consumed.log", "composed")
elif MODE == "fail":
    sys.exit(1)
else:
    print(f"unknown mode: {MODE}", file=sys.stderr)
    sys.exit(2)
PYJOB

cat >"${sched}/scripts/evidence/validation-gates.json" <<'JSON'
{
  "schemaVersion": 1,
  "evidenceDirectory": "evidence",
  "localLogDirectory": "evidence/local",
  "clockSkewSeconds": 300,
  "securityMaxAgeSeconds": 86400,
  "runner": {"maxWorkers": 2, "resources": {"cpu": 2, "repo-write": 1, "docker": 1, "network": 1}},
  "nonProductPaths": ["docs/", "bin/", "scripts/"],
  "releaseOnly": {"exact": [], "prefixes": [], "patterns": []},
  "securityInputs": {"exact": [], "patterns": []},
  "gates": {
    "alpha": {"kind": "source", "environment": "toolchain", "resource": "cpu", "paths": ["src/alpha/"],
      "commands": [{"id": "alpha", "argv": ["python3", "bin/job.py", "overlap", "alpha", "beta"]}]},
    "beta": {"kind": "source", "environment": "toolchain", "resource": "cpu", "paths": ["src/beta/"],
      "commands": [{"id": "beta", "argv": ["python3", "bin/job.py", "overlap", "beta", "alpha"]}]},
    "m1": {"kind": "source", "environment": "toolchain", "resource": "cpu", "paths": ["src/m/"],
      "commands": [{"id": "m1", "argv": ["python3", "bin/job.py", "maxworkers", "evidence/state/workers.json"]}]},
    "m2": {"kind": "source", "environment": "toolchain", "resource": "cpu", "paths": ["src/m/"],
      "commands": [{"id": "m2", "argv": ["python3", "bin/job.py", "maxworkers", "evidence/state/workers.json"]}]},
    "m3": {"kind": "source", "environment": "toolchain", "resource": "cpu", "paths": ["src/m/"],
      "commands": [{"id": "m3", "argv": ["python3", "bin/job.py", "maxworkers", "evidence/state/workers.json"]}]},
    "m4": {"kind": "source", "environment": "toolchain", "resource": "cpu", "paths": ["src/m/"],
      "commands": [{"id": "m4", "argv": ["python3", "bin/job.py", "maxworkers", "evidence/state/workers.json"]}]},
    "x1": {"kind": "source", "environment": "toolchain", "resource": "repo-write", "paths": ["src/x/"],
      "commands": [{"id": "x1", "argv": ["python3", "bin/job.py", "exclusive", "evidence/state/x.lock"]}]},
    "x2": {"kind": "source", "environment": "toolchain", "resource": "repo-write", "paths": ["src/x/"],
      "commands": [{"id": "x2", "argv": ["python3", "bin/job.py", "exclusive", "evidence/state/x.lock"]}]},
    "dep-parent": {"kind": "source", "environment": "toolchain", "resource": "cpu", "paths": ["src/dep-parent/"],
      "commands": [{"id": "dep-parent", "argv": ["python3", "bin/job.py", "mark", "evidence/state/parent.done"]}]},
    "dep-child": {"kind": "source", "environment": "toolchain", "resource": "cpu", "paths": ["src/dep-child/"],
      "dependsOn": ["dep-parent"],
      "commands": [{"id": "dep-child", "argv": ["python3", "bin/job.py", "dep", "evidence/state/parent.done"]}]},
    "s1": {"kind": "source", "environment": "toolchain", "resource": "cpu", "paths": ["src/shared/"],
      "commands": [{"id": "shared-node", "sharedKey": "shared-node", "argv": ["python3", "bin/job.py", "shared", "evidence/state/shared.log"]}]},
    "s2": {"kind": "source", "environment": "toolchain", "resource": "cpu", "paths": ["src/shared/"],
      "commands": [{"id": "shared-node", "sharedKey": "shared-node", "argv": ["python3", "bin/job.py", "shared", "evidence/state/shared.log"]}]},
    "fail": {"kind": "source", "environment": "toolchain", "resource": "cpu", "paths": ["src/fail/"],
      "commands": [{"id": "fail", "argv": ["python3", "bin/job.py", "fail"]}]},
    "a-fast": {"kind": "source", "environment": "toolchain", "resource": "cpu", "paths": ["src/fast/"],
      "commands": [{"id": "a-fast", "argv": ["python3", "bin/job.py", "mark", "evidence/state/fast.done"]}]},
    "b-slow": {"kind": "source", "environment": "toolchain", "resource": "cpu", "paths": ["src/slow/"],
      "commands": [{"id": "b-slow", "argv": ["python3", "bin/job.py", "sleepjob", "evidence/state/slow.pid", "3"]}]},
    "prod-a": {"kind": "source", "environment": "toolchain", "resource": "cpu", "paths": ["src/prod-a/"],
      "commands": [{"id": "prod-a", "argv": ["python3", "bin/job.py", "mark", "evidence/state/prod-a.log"]}]},
    "prod-b": {"kind": "source", "environment": "toolchain", "resource": "cpu", "paths": ["src/prod-b/"],
      "commands": [{"id": "prod-b", "argv": ["python3", "bin/job.py", "mark", "evidence/state/prod-b.log"]}]},
    "rubric": {"kind": "source", "environment": "toolchain", "resource": "repo-write", "paths": ["**"],
      "dependsOn": ["prod-a", "prod-b"],
      "commands": [{"id": "rubric", "argv": ["python3", "bin/job.py", "consume", "prod-a", "prod-b"],
        "consumeLog": true, "env": {"APPTHEORY_EVIDENCE_REUSE": "prod-a,prod-b"}}]},
    "inc-a": {"kind": "source", "environment": "toolchain", "resource": "cpu", "paths": ["src/inc-a/"],
      "commands": [{"id": "inc-a", "argv": ["python3", "bin/job.py", "mark", "evidence/state/inc-a.log"]}]},
    "inc-b": {"kind": "source", "environment": "toolchain", "resource": "cpu", "paths": ["src/inc-b/"],
      "commands": [{"id": "inc-b", "argv": ["python3", "bin/job.py", "mark", "evidence/state/inc-b.log"]}]}
  }
}
JSON

cp "${evidence_py}" "${sched}/scripts/evidence/validation_evidence.py"
cp "${repo_root}/scripts/evidence/verify-or-execute.sh" "${sched}/scripts/evidence/verify-or-execute.sh"
cp "${repo_root}/scripts/evidence/reuse-if-recorded.sh" "${sched}/scripts/evidence/reuse-if-recorded.sh"
cp "${repo_root}/scripts/evidence/collect.sh" "${sched}/scripts/evidence/collect.sh"

(
  cd "${sched}"
  git init -q -b main
  git config user.name "validation-evidence scheduler self-test"
  git config user.email "validation-evidence@example.invalid"
  git config commit.gpgsign false
  git add -A
  git commit -q -m "fix: seed scheduler fixture"
)

sched_collect() {
  (cd "${sched}" && bash scripts/evidence/collect.sh "$@")
}
sched_verify() {
  (cd "${sched}" && python3 scripts/evidence/validation_evidence.py verify --gate "$1")
}
sched_commit() {
  (cd "${sched}" && git add -A && git commit -q -m "$1")
}

# Two independent jobs overlap. Each waits for the peer's start marker; a
# serialized scheduler would time out instead of passing. This is a barrier,
# not a timing threshold.
expect_ok "independent jobs overlap" sched_collect --gate alpha --gate beta
grep -Fxq "alpha" "${sched}/evidence/state/runs.log" || { echo "test-validation-evidence: FAIL (alpha did not run)" >&2; exit 1; }
grep -Fxq "beta" "${sched}/evidence/state/runs.log" || { echo "test-validation-evidence: FAIL (beta did not run)" >&2; exit 1; }
pass_count=$((pass_count + 1))
echo "test-validation-evidence: PASS overlap barrier observed"

# The second unchanged run executes zero commands and reports verified.
: >"${sched}/evidence/state/runs.log"
expect_output "unchanged second run executes zero commands" "executed=0 commands=0" sched_collect --gate alpha --gate beta
if [[ -s "${sched}/evidence/state/runs.log" ]]; then
  echo "test-validation-evidence: FAIL (unchanged run executed a command)" >&2
  exit 1
fi
pass_count=$((pass_count + 1))
echo "test-validation-evidence: PASS zero-command second run"

# Establish a baseline for both incremental gates, then change one input.
expect_ok "incremental baseline" sched_collect --gate inc-a --gate inc-b

# One changed gate input executes only its dependent check.
printf 'changed\n' >>"${sched}/src/inc-a/x.txt"
sched_commit "fix: change inc-a input"
: >"${sched}/evidence/state/inc-a.log"
: >"${sched}/evidence/state/inc-b.log"
expect_ok "changed gate input executes only the affected check" sched_collect --gate inc-a --gate inc-b
grep -q "run" "${sched}/evidence/state/inc-a.log" || { echo "test-validation-evidence: FAIL (inc-a did not run)" >&2; exit 1; }
if [[ -s "${sched}/evidence/state/inc-b.log" ]]; then
  echo "test-validation-evidence: FAIL (inc-b re-ran for an unrelated input change)" >&2
  exit 1
fi
pass_count=$((pass_count + 1))
echo "test-validation-evidence: PASS affected-only scheduling"

# A documentation-only change does not invalidate product proof.
printf 'more docs\n' >>"${sched}/docs/note.md"
sched_commit "fix: docs-only change"
: >"${sched}/evidence/state/inc-a.log"
: >"${sched}/evidence/state/inc-b.log"
expect_output "docs-only change keeps product proof" "executed=0" sched_collect --gate inc-a --gate inc-b
if [[ -s "${sched}/evidence/state/inc-a.log" || -s "${sched}/evidence/state/inc-b.log" ]]; then
  echo "test-validation-evidence: FAIL (docs-only change executed a product gate)" >&2
  exit 1
fi
pass_count=$((pass_count + 1))
echo "test-validation-evidence: PASS docs-only change does not invalidate product proof"

# An unknown file falls back to broad execution instead of silently reusing.
printf 'unknown\n' >"${sched}/unknown.bin"
sched_commit "fix: add an unknown input"
: >"${sched}/evidence/state/inc-a.log"
: >"${sched}/evidence/state/inc-b.log"
expect_ok "unknown input falls back to broad execution" sched_collect --gate inc-a --gate inc-b
grep -q "run" "${sched}/evidence/state/inc-a.log" || { echo "test-validation-evidence: FAIL (unknown input did not force inc-a)" >&2; exit 1; }
grep -q "run" "${sched}/evidence/state/inc-b.log" || { echo "test-validation-evidence: FAIL (unknown input did not force inc-b)" >&2; exit 1; }
rm -f "${sched}/unknown.bin"
sched_commit "fix: remove the unknown input"
pass_count=$((pass_count + 1))
echo "test-validation-evidence: PASS unknown input fails safely"

# Worker bound: four CPU jobs with maxWorkers=2 never exceed two at once and do
# overlap at least once.
expect_ok "worker bound run" sched_collect --gate m1 --gate m2 --gate m3 --gate m4
python3 - "${sched}/evidence/state/workers.json" <<'PYBOUND'
import json
import sys

data = json.load(open(sys.argv[1], encoding="utf-8"))
if data["max"] > 2:
    raise SystemExit(f"worker bound exceeded: {data['max']}")
if data["max"] < 2:
    raise SystemExit(f"jobs did not overlap: {data['max']}")
PYBOUND
pass_count=$((pass_count + 1))
echo "test-validation-evidence: PASS bounded parallel workers"

# Resource serialization: two writers on one resource never overlap.
expect_ok "same resource serializes" sched_collect --gate x1 --gate x2
test ! -e "${sched}/evidence/state/x.lock" || { echo "test-validation-evidence: FAIL (resource lock leaked)" >&2; exit 1; }
pass_count=$((pass_count + 1))
echo "test-validation-evidence: PASS resource serialization"

# Dependency ordering: the child only passes when the parent's marker exists.
expect_ok "dependencies respected" sched_collect --gate dep-parent --gate dep-child
grep -q "run" "${sched}/evidence/state/dep-child.log" || { echo "test-validation-evidence: FAIL (dependent did not run)" >&2; exit 1; }
pass_count=$((pass_count + 1))
echo "test-validation-evidence: PASS dependency ordering"

# A shared command node executes once even when two gates declare it.
expect_ok "shared command executes once" sched_collect --gate s1 --gate s2
shared_lines="$(wc -l <"${sched}/evidence/state/shared.log" | tr -d ' ')"
if [[ "${shared_lines}" != "1" ]]; then
  echo "test-validation-evidence: FAIL (shared command ran ${shared_lines} times)" >&2
  exit 1
fi
pass_count=$((pass_count + 1))
echo "test-validation-evidence: PASS shared command deduplicated"

# Failure propagates non-zero and is retained honestly.
fail_status=0
sched_collect --gate fail >"${tmp}/fail.log" 2>&1 || fail_status=$?
if [[ "${fail_status}" -eq 0 ]]; then
  echo "test-validation-evidence: FAIL (failing gate returned success)" >&2
  cat "${tmp}/fail.log" >&2
  exit 1
fi
grep -Fq '"verdict": "FAIL"' "${sched}/evidence/fail.json" || { echo "test-validation-evidence: FAIL (failed record not retained)" >&2; exit 1; }
fail_verify_status=0
sched_verify fail >"${tmp}/fail-verify.log" 2>&1 || fail_verify_status=$?
if [[ "${fail_verify_status}" -eq 0 ]]; then
  echo "test-validation-evidence: FAIL (verify accepted a failed record)" >&2
  exit 1
fi
pass_count=$((pass_count + 1))
echo "test-validation-evidence: PASS failure propagation"

# Interruption: the completed record survives, the incomplete gate has no
# record, the owned child is gone, and restart runs only the incomplete gate.
rm -f "${sched}/evidence/a-fast.json" "${sched}/evidence/b-slow.json" "${sched}/evidence/state/slow.pid"
(
  cd "${sched}"
  exec bash scripts/evidence/collect.sh --gate a-fast --gate b-slow --jobs 1
) >"${tmp}/interrupt.log" 2>&1 &
collector_pid=$!
for _ in $(seq 1 100); do
  if [[ -f "${sched}/evidence/a-fast.json" && -f "${sched}/evidence/state/slow.pid" ]]; then
    break
  fi
  sleep 0.1
done
kill -TERM "${collector_pid}" 2>/dev/null || true
interrupt_status=0
wait "${collector_pid}" 2>/dev/null || interrupt_status=$?
if [[ "${interrupt_status}" -eq 0 ]]; then
  echo "test-validation-evidence: FAIL (interrupted collector returned success)" >&2
  cat "${tmp}/interrupt.log" >&2
  exit 1
fi
[[ -f "${sched}/evidence/a-fast.json" ]] || { echo "test-validation-evidence: FAIL (completed record lost on interrupt)" >&2; exit 1; }
[[ ! -f "${sched}/evidence/b-slow.json" ]] || { echo "test-validation-evidence: FAIL (incomplete gate published a record)" >&2; exit 1; }
slow_pid="$(cat "${sched}/evidence/state/slow.pid" 2>/dev/null || true)"
if [[ -n "${slow_pid}" ]] && kill -0 "${slow_pid}" 2>/dev/null; then
  echo "test-validation-evidence: FAIL (owned child survived cancellation)" >&2
  kill -KILL "${slow_pid}" 2>/dev/null || true
  exit 1
fi
expect_ok "restart resumes only incomplete work" sched_collect --gate a-fast --gate b-slow
[[ -f "${sched}/evidence/b-slow.json" ]] || { echo "test-validation-evidence: FAIL (restart did not complete the gate)" >&2; exit 1; }
pass_count=$((pass_count + 1))
echo "test-validation-evidence: PASS interruption resume and child cleanup"

# Rubric composition: product gates run once, the rubric consumes their
# verified records, and the record carries explicit coverage attribution.
rm -f "${sched}/evidence/prod-a.json" "${sched}/evidence/prod-b.json" "${sched}/evidence/rubric.json"
: >"${sched}/evidence/state/prod-a.log"
: >"${sched}/evidence/state/prod-b.log"
expect_ok "rubric composes product records" sched_collect --gate prod-a --gate prod-b --gate rubric
a_lines="$(wc -l <"${sched}/evidence/state/prod-a.log" | tr -d ' ')"
b_lines="$(wc -l <"${sched}/evidence/state/prod-b.log" | tr -d ' ')"
if [[ "${a_lines}" != "1" || "${b_lines}" != "1" ]]; then
  echo "test-validation-evidence: FAIL (product commands were repeated: a=${a_lines} b=${b_lines})" >&2
  exit 1
fi
python3 - "${sched}/evidence/rubric.json" <<'PYCOVER'
import json
import sys

record = json.load(open(sys.argv[1], encoding="utf-8"))
consumed = {item["gate"] for item in record.get("consumed", [])}
if consumed != {"prod-a", "prod-b"}:
    raise SystemExit(f"coverage attribution is wrong: {sorted(consumed)}")
PYCOVER
expect_ok "rubric record verifies with its consumed records" sched_verify rubric
cp "${sched}/evidence/prod-b.json" "${tmp}/prod-b.good"
rm -f "${sched}/evidence/prod-b.json"
expect_fail "rubric verification rejects a deleted consumed record" sched_verify rubric
cp "${tmp}/prod-b.good" "${sched}/evidence/prod-b.json"
expect_ok "rubric verification recovers the consumed record" sched_verify rubric
pass_count=$((pass_count + 1))
echo "test-validation-evidence: PASS rubric coverage composition"

# Composition cannot fabricate a pass: a missing product record makes the
# composed rubric command fail.
rm -f "${sched}/evidence/prod-a.json" "${sched}/evidence/rubric.json"
rubric_status=0
sched_collect --gate rubric --force >"${tmp}/rubric-fail.log" 2>&1 || rubric_status=$?
if [[ "${rubric_status}" -eq 0 ]]; then
  echo "test-validation-evidence: FAIL (rubric passed without a product record)" >&2
  cat "${tmp}/rubric-fail.log" >&2
  exit 1
fi
pass_count=$((pass_count + 1))
echo "test-validation-evidence: PASS rubric rejects missing composed proof"

# Records are valid JSON, no temporary writer files remain, and the summary is
# deterministic across unchanged runs.
python3 - "${sched}/evidence" <<'PYJSON'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
records = sorted(root.glob("*.json"))
if not records:
    raise SystemExit("no records written")
for path in records:
    json.loads(path.read_text(encoding="utf-8"))
leftover = list(root.glob(".evidence.*.tmp"))
if leftover:
    raise SystemExit(f"temporary record files remain: {leftover}")
PYJSON
first_summary="$(sched_collect --gate inc-a --gate inc-b 2>&1 | grep '^validation-evidence: gate=' || true)"
second_summary="$(sched_collect --gate inc-a --gate inc-b 2>&1 | grep '^validation-evidence: gate=' || true)"
if [[ "${first_summary}" != "${second_summary}" ]]; then
  echo "test-validation-evidence: FAIL (summary is not deterministic)" >&2
  printf '%s\n%s\n' "${first_summary}" "${second_summary}" >&2
  exit 1
fi
pass_count=$((pass_count + 1))
echo "test-validation-evidence: PASS atomic records and deterministic summary"

# Legacy records without a scope binding are historical, not reusable.
cp "${sched}/evidence/inc-a.json" "${tmp}/inc-a.good"
python3 - "${sched}/evidence/inc-a.json" <<'PYLEGACY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
record = json.loads(path.read_text(encoding="utf-8"))
record.pop("scope", None)
path.write_text(json.dumps(record), encoding="utf-8")
PYLEGACY
expect_fail "legacy record without scope is not reusable" sched_verify inc-a
cp "${tmp}/inc-a.good" "${sched}/evidence/inc-a.json"
expect_ok "rescoped record verifies again" sched_verify inc-a

# The actual CLI wrapper uses the scheduler/reuse default and can show the
# schedule without executing.
expect_output "collect wrapper exposes the incremental dry-run" "dry-run" \
  bash -c 'cd "$1" && bash scripts/evidence/collect.sh --all --dry-run' _ "${sched}"

echo "test-validation-evidence: PASS (${pass_count} checks)"
