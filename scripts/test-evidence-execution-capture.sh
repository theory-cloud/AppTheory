#!/usr/bin/env bash
# Purpose: prove that locally collected evidence is honest and that the CI entry
# point verifies it without executing anything.
#
# Every case runs the real collector, the real verifier and the real CI entry
# point against a throwaway git repository with cheap, controlled commands. The
# assertions are about the actual record file and the actual command-execution
# counters, not about a disconnected model:
#
#   * collection executes once, writes a record with the real command, inputs
#     and environment, verifies, and a second identical collection executes
#     zero commands;
#   * the CI entry point verifies that record without executing it, and a gate
#     with no applicable record fails with the local collection command;
#   * failed, cancelled and during-run-edited work is never published as PASS;
#   * a profile the host cannot produce is refused or labeled with the tracked
#     fallback that really ran, never mislabeled;
#   * a composed gate consumes a verified dependency locally, and a forced run
#     never consumes it;
#   * the tracked nested evidence directory round-trips through collection and
#     verification;
#   * the workflows verify: no job uploads a produced record, none carries a
#     force switch, and the only execution left is the generated release delta.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python_bin="${PYTHON:-python3}"
evidence_py="${repo_root}/scripts/evidence/validation_evidence.py"

# These tests run from the rubric collector too, which exports the evidence
# environment for its own commands. The fixtures control their own reuse and
# force behavior, so inherited collector state must not leak in.
unset EVIDENCE_FORCE_EXECUTE APPTHEORY_EVIDENCE_REUSE APPTHEORY_EVIDENCE_PROFILE \
  APPTHEORY_EVIDENCE_CONSUME_LOG

tmp="$(mktemp -d "${TMPDIR:-/tmp}/apptheory-evidence-collection.XXXXXX")"
trap 'rm -rf "${tmp}"' EXIT

scratch="${tmp}/repo"
registry="${tmp}/registry.json"
mkdir -p "${scratch}/evidence" "${scratch}/src" "${scratch}/bin" "${scratch}/docs" "${scratch}/scripts/evidence"

cat >"${registry}" <<'JSON'
{
  "schemaVersion": 1,
  "evidenceDirectory": "evidence",
  "localLogDirectory": "evidence/local",
  "clockSkewSeconds": 300,
  "securityMaxAgeSeconds": 86400,
  "runner": {"maxWorkers": 2, "resources": {"cpu": 2, "repo-write": 1, "docker": 1, "network": 1}},
  "nonProductPaths": ["docs/", "scripts/", "bin/"],
  "releaseOnly": {"exact": ["VERSION"], "prefixes": [], "patterns": []},
  "securityInputs": {"exact": ["deps.lock"], "patterns": []},
  "gates": {
    "capture": {
      "kind": "source", "environment": "toolchain",
      "profiles": ["default", "portable"], "resource": "cpu", "paths": ["src/"],
      "commands": [{"id": "capture", "argv": ["python3", "bin/job.py", "mark", "evidence/state/capture.log"]}]
    },
    "never-collected": {
      "kind": "source", "environment": "toolchain", "profiles": ["default"],
      "resource": "cpu", "paths": ["src/"],
      "commands": [{"id": "never-collected", "argv": ["python3", "bin/job.py", "mark", "evidence/state/never.log"]}]
    },
    "failing": {
      "kind": "source", "environment": "toolchain", "profiles": ["default"],
      "resource": "cpu", "paths": ["src/"],
      "commands": [{"id": "failing", "argv": ["python3", "bin/job.py", "fail-mark", "evidence/state/failing.log"]}]
    },
    "mutator": {
      "kind": "source", "environment": "toolchain", "profiles": ["default"],
      "resource": "cpu", "paths": ["src/"],
      "commands": [{"id": "mutator", "argv": ["python3", "bin/job.py", "mutate", "src/x.txt"]}]
    },
    "slow": {
      "kind": "source", "environment": "toolchain", "profiles": ["default"],
      "resource": "cpu", "paths": ["src/"],
      "commands": [{"id": "slow", "argv": ["python3", "bin/job.py", "sleep", "30"]}]
    },
    "platform-bound": {
      "kind": "source", "environment": "toolchain+platform",
      "profiles": ["foreign", "fallback"], "fallbackProfiles": ["fallback"],
      "resource": "cpu", "paths": ["src/"],
      "commands": [{"id": "platform-bound", "argv": ["python3", "bin/job.py", "mark", "evidence/state/platform.log"]}]
    },
    "unproducible": {
      "kind": "source", "environment": "toolchain+platform", "profiles": ["foreign"],
      "resource": "cpu", "paths": ["src/"],
      "commands": [{"id": "unproducible", "argv": ["python3", "bin/job.py", "mark", "evidence/state/unproducible.log"]}]
    },
    "nested-dep": {
      "kind": "source", "environment": "toolchain", "profiles": ["default"],
      "resource": "cpu", "paths": ["src/"],
      "commands": [{"id": "nested-dep", "argv": ["python3", "bin/job.py", "mark", "evidence/state/nested-dep.log"]}]
    },
    "nested": {
      "kind": "source", "environment": "toolchain", "profiles": ["default"],
      "dependsOn": ["nested-dep"], "composedFrom": ["nested-dep"],
      "resource": "cpu", "paths": ["src/"],
      "commands": [{
        "id": "nested",
        "argv": ["python3", "bin/job.py", "compose", "nested-dep", "evidence/state/nested.log"],
        "consumeLog": true,
        "env": {"APPTHEORY_EVIDENCE_REUSE": "nested-dep"}
      }]
    }
  }
}
JSON

# Probe from inside the fixture checkout: the fixture repository has no go.mod,
# so the probe reports the same toolchain the fixture commands will run under.
live_environment_json="$(cd "${scratch}" && "${python_bin}" "${evidence_py}" probe)"

# The default/fallback profiles mirror this host exactly, so a record can be
# produced anywhere. The foreign profile names the other platform: a
# platform-bound claim must not be produced under it, and the verifier still
# compares a record with its tracked profile rather than with its own runner.
"${python_bin}" - "${registry}" "${live_environment_json}" <<'PY'
import json
import sys
from pathlib import Path

path, live_raw = sys.argv[1], sys.argv[2]
probe = json.loads(live_raw)
live = {
    "go": probe["go"],
    "node": str(probe["node"]).lstrip("v").split(".")[0],
    "python": ".".join(str(probe["python"]).split(".")[:2]),
    "platform": probe["platform"],
}
other_os = "linux" if live["platform"]["os"] != "linux" else "darwin"
other_arch = "x64" if other_os == "linux" else "arm64"
data = json.loads(Path(path).read_text(encoding="utf-8"))
data["proofProfiles"] = {
    "default": {"environment": live},
    "fallback": {"environment": live},
    "portable": {"environment": {**live, "platform": {"os": other_os, "arch": other_arch}}},
    "foreign": {"environment": {**live, "platform": {"os": other_os, "arch": other_arch}}},
}
Path(path).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY

cat >"${scratch}/bin/job.py" <<'PYJOB'
import os
import subprocess
import sys
import time


def append(path, line):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")


mode = sys.argv[1]
if mode == "mark":
    append(sys.argv[2], "run")
elif mode == "fail-mark":
    append(sys.argv[2], "run")
    sys.exit(1)
elif mode == "mutate":
    append(sys.argv[2], "mutated during the run")
elif mode == "sleep":
    with open("evidence/state/slow.pid", "w", encoding="utf-8") as handle:
        handle.write(str(os.getpid()))
    time.sleep(float(sys.argv[2]))
elif mode == "compose":
    dependency, marker = sys.argv[2], sys.argv[3]
    completed = subprocess.run(
        ["bash", "scripts/evidence/reuse-if-recorded.sh", dependency],
        capture_output=True,
        text=True,
        check=False,
    )
    append(marker, "composed" if completed.returncode == 0 else "ran")
else:
    raise SystemExit(f"unknown mode {mode}")
PYJOB

printf 'one\n' >"${scratch}/src/x.txt"
printf 'keep\n' >"${scratch}/docs/note.md"
printf '1.0.0\n' >"${scratch}/VERSION"
printf 'dep\n' >"${scratch}/deps.lock"
printf 'keep\n' >"${scratch}/evidence/.gitkeep"

cp "${evidence_py}" "${scratch}/scripts/evidence/validation_evidence.py"
cp "${registry}" "${scratch}/scripts/evidence/validation-gates.json"
cp "${repo_root}/scripts/evidence/verify-gate.sh" "${scratch}/scripts/evidence/verify-gate.sh"
cp "${repo_root}/scripts/evidence/reuse-if-recorded.sh" "${scratch}/scripts/evidence/reuse-if-recorded.sh"
cp "${repo_root}/scripts/evidence/collect.sh" "${scratch}/scripts/evidence/collect.sh"

(
  cd "${scratch}"
  git init -q -b main
  git config user.name "evidence-collection self-test"
  git config user.email "evidence-collection@example.invalid"
  git config commit.gpgsign false
  git add -A
  git commit -q -m "fix: seed collection fixture"
)

pass_count=0
fail_test() {
  echo "test-evidence-collection: FAIL ($1)" >&2
  if [[ -f "${tmp}/out.log" ]]; then
    cat "${tmp}/out.log" >&2
  fi
  exit 1
}
pass_test() {
  pass_count=$((pass_count + 1))
  echo "test-evidence-collection: PASS $1"
}

collect() {
  (cd "${scratch}" && bash scripts/evidence/collect.sh "$@")
}
verify_gate() {
  (cd "${scratch}" && bash scripts/evidence/verify-gate.sh "$@")
}
record_py() {
  (cd "${scratch}" && "${python_bin}" scripts/evidence/validation_evidence.py "$@")
}
count_lines() {
  if [[ -f "$1" ]]; then
    wc -l <"$1" | tr -d ' '
  else
    echo 0
  fi
}

# ---------------------------------------------------------------------------
# 1. The collector executes once, records the real command/inputs/host, and
#    verifies; an identical second collection executes zero commands.
# ---------------------------------------------------------------------------
if ! collect --gate capture >"${tmp}/out.log" 2>&1; then
  fail_test "first collection failed"
fi
grep -Fq "action=executed" "${tmp}/out.log" || fail_test "first collection did not report execution"
record="${scratch}/evidence/capture/default.json"
[[ -f "${record}" ]] || fail_test "collection wrote no record"
probe_json="$(cd "${scratch}" && "${python_bin}" scripts/evidence/validation_evidence.py probe)"
"${python_bin}" - "${record}" "${probe_json}" <<'PY' || fail_test "record does not capture the real command, inputs and environment"
import json
import re
import sys

record = json.load(open(sys.argv[1], encoding="utf-8"))
probe = json.loads(sys.argv[2])
expected_node = str(probe["node"]).lstrip("v").split(".")[0]
expected_python = ".".join(str(probe["python"]).split(".")[:2])
assert record["verdict"] == "PASS", record["verdict"]
assert record["profile"] == "default", record["profile"]
assert record["commands"][0]["argv"] == ["python3", "bin/job.py", "mark", "evidence/state/capture.log"]
assert record["commands"][0]["executed"] is True
assert record["commands"][0]["exitCode"] == 0
assert re.fullmatch(r"sha256:[0-9a-f]{64}", record["commands"][0]["logDigest"])
assert re.fullmatch(r"sha256:[0-9a-f]{64}", record["commands"][0]["inputsDigest"])
assert re.fullmatch(r"sha256:[0-9a-f]{64}", record["scope"]["digest"])
environment = record["environment"]
assert environment["go"] == probe["go"], (environment, probe)
assert str(environment["node"]).lstrip("v").split(".")[0] == expected_node
assert ".".join(str(environment["python"]).split(".")[:2]) == expected_python
assert environment["platform"] == probe["platform"], (environment, probe)
PY
[[ "$(count_lines "${scratch}/evidence/state/capture.log")" == "1" ]] || fail_test "the command did not execute exactly once"
record_py verify --gate capture >"${tmp}/out.log" 2>&1 || fail_test "collected record does not verify on the same inputs/profile"
pass_test "collection writes a verifiable record with the real command, inputs and environment"

if ! collect --gate capture >"${tmp}/out.log" 2>&1; then
  fail_test "second collection failed"
fi
grep -Fq "no command executed in this run" "${tmp}/out.log" || fail_test "second collection did not report reuse"
[[ "$(count_lines "${scratch}/evidence/state/capture.log")" == "1" ]] || fail_test "second collection re-executed the command"
pass_test "identical second collection executes zero commands"

# ---------------------------------------------------------------------------
# 2. The CI entry point verifies without executing, and fails closed when no
#    record applies.
# ---------------------------------------------------------------------------
if ! verify_gate --gate capture --profile default >"${tmp}/out.log" 2>&1; then
  fail_test "the CI entry point rejected a collected record"
fi
grep -Fq "evidence-verified" "${tmp}/out.log" || fail_test "the CI entry point did not report verification"
grep -Fq "executing" "${tmp}/out.log" && fail_test "the CI entry point reported an execution"
[[ "$(count_lines "${scratch}/evidence/state/capture.log")" == "1" ]] || fail_test "the CI entry point executed the gate"
pass_test "the CI entry point verifies a record and executes nothing"

if verify_gate --gate never-collected --profile default >"${tmp}/out.log" 2>&1; then
  fail_test "the CI entry point accepted a gate with no record"
fi
grep -Fq "produce evidence locally" "${tmp}/out.log" || fail_test "a missing record did not name the local collection command"
grep -Fq "collect.sh --gate never-collected --profile default" "${tmp}/out.log" || fail_test "the failure did not name the exact collection command"
[[ ! -f "${scratch}/evidence/state/never.log" ]] || fail_test "the CI entry point executed a gate with no record"
pass_test "a missing record fails closed with the local collection command"

# A stale record is the same failure: the tree moved, the record did not.
printf 'two\n' >>"${scratch}/src/x.txt"
(
  cd "${scratch}"
  git add src/x.txt
  git commit -q -m "fix: change a validated input"
)
if verify_gate --gate capture --profile default >"${tmp}/out.log" 2>&1; then
  fail_test "the CI entry point accepted a stale record"
fi
grep -Fq "produce evidence locally" "${tmp}/out.log" || fail_test "a stale record did not name the local collection command"
[[ "$(count_lines "${scratch}/evidence/state/capture.log")" == "1" ]] || fail_test "a stale record was executed instead of refused"
pass_test "a stale record fails closed and is never executed"

# The verifier never consults its own runner: a portable claim produced here is
# disclosed with its real environment and is verified against the tracked
# profile declaration, not against the host that runs the verifier.
if ! (cd "${scratch}" && bash scripts/evidence/collect.sh --gate capture --profile portable) >"${tmp}/out.log" 2>&1; then
  fail_test "could not collect the portable profile"
fi
record_py verify --gate capture --profile portable >"${tmp}/out.log" 2>&1 || fail_test "portable profile does not verify"
verify_gate --gate capture --profile portable >"${tmp}/out.log" 2>&1 || fail_test "the CI entry point rejected the portable profile"
pass_test "local proof verification is independent of the verifier host"

# ---------------------------------------------------------------------------
# 3. Failed, cancelled and during-run-edited work is never published as PASS.
# ---------------------------------------------------------------------------
if collect --gate failing >"${tmp}/out.log" 2>&1; then
  fail_test "a failing command returned success"
fi
grep -Fq '"verdict": "FAIL"' "${scratch}/evidence/failing/default.json" || fail_test "failed command did not retain a FAIL record"
record_py verify --gate failing >"${tmp}/out.log" 2>&1 && fail_test "a FAIL record verified as reusable"
if verify_gate --gate failing --profile default >"${tmp}/out.log" 2>&1; then
  fail_test "the CI entry point accepted a FAIL record"
fi
pass_test "failed work is retained as FAIL and never reused"

if collect --gate mutator >"${tmp}/out.log" 2>&1; then
  fail_test "a during-run edit returned success"
fi
grep -Fq "changed during the run" "${scratch}/evidence/mutator/default.json" || fail_test "a during-run edit was not recorded as tainted"
grep -Fq '"verdict": "FAIL"' "${scratch}/evidence/mutator/default.json" || fail_test "a tainted record was not FAIL"
record_py verify --gate mutator >"${tmp}/out.log" 2>&1 && fail_test "a tainted record verified as reusable"
(cd "${scratch}" && git checkout -q -- src/x.txt)
pass_test "a changed input during execution is tainted and refused"

(cd "${scratch}" && exec bash scripts/evidence/collect.sh --gate slow) >"${tmp}/cancel.log" 2>&1 &
slow_pid=$!
for _ in $(seq 1 100); do
  [[ -f "${scratch}/evidence/state/slow.pid" ]] && break
  sleep 0.05
done
kill -TERM "${slow_pid}" 2>/dev/null || true
cancel_status=0
wait "${slow_pid}" || cancel_status=$?
[[ "${cancel_status}" -ne 0 ]] || fail_test "a cancelled run returned success"
grep -Fq "PASS" "${tmp}/cancel.log" && fail_test "a cancelled run printed PASS"
[[ -f "${scratch}/evidence/slow/default.json" ]] && fail_test "a cancelled run wrote a PASS record"
pass_test "a cancelled run is not PASS and writes no record"

# ---------------------------------------------------------------------------
# 4. Wrong producing environment: refuse, or use only a tracked fallback with
#    truthful attribution. Nothing is labeled with a profile this host is not.
# ---------------------------------------------------------------------------
if collect --gate unproducible --profile foreign >"${tmp}/out.log" 2>&1; then
  fail_test "an unsatisfiable profile was accepted"
fi
grep -Fq "does not satisfy the requested proof profile" "${tmp}/out.log" || fail_test "the unsatisfiable profile was not refused clearly"
[[ -f "${scratch}/evidence/unproducible/foreign.json" ]] && fail_test "an unsatisfiable profile wrote a record"
pass_test "an unsatisfiable profile is refused without false provenance"

if ! record_py run --gate platform-bound --profile foreign --forced >"${tmp}/out.log" 2>&1; then
  fail_test "the tracked fallback production failed"
fi
grep -Fq "fallback" "${tmp}/out.log" || fail_test "fallback production was not reported"
[[ -f "${scratch}/evidence/platform-bound/fallback.json" ]] || fail_test "no fallback record was produced"
[[ -f "${scratch}/evidence/platform-bound/foreign.json" ]] && fail_test "a foreign profile record was falsely labeled"
"${python_bin}" - "${scratch}/evidence/platform-bound/fallback.json" "${probe_json}" <<'PY' || fail_test "the fallback record does not name the real producing environment"
import json
import sys

record = json.load(open(sys.argv[1], encoding="utf-8"))
probe = json.loads(sys.argv[2])
assert record["profile"] == "fallback", record["profile"]
assert record["environment"]["platform"] == probe["platform"], (record["environment"], probe)
PY
record_py verify --gate platform-bound --profile fallback >"${tmp}/out.log" 2>&1 || fail_test "the fallback record does not verify under its own profile"
record_py verify --gate platform-bound --profile foreign >"${tmp}/out.log" 2>&1 && fail_test "the fallback record satisfied the foreign profile"
if ! verify_gate --gate platform-bound --profile foreign >"${tmp}/out.log" 2>&1; then
  fail_test "the CI entry point did not honor the tracked fallback profile"
fi
grep -Fq "fallback" "${tmp}/out.log" || fail_test "the verification line did not name the fallback profile"
[[ "$(count_lines "${scratch}/evidence/state/platform.log")" == "1" ]] || fail_test "the fallback proof was re-executed"
pass_test "a host that cannot produce the requested profile uses a tracked, truthfully labeled fallback"

# ---------------------------------------------------------------------------
# 5. Composition: a composed gate consumes a verified dependency locally, and
#    a forced run refuses nested proof.
# ---------------------------------------------------------------------------
if ! record_py collect --gate nested-dep >"${tmp}/out.log" 2>&1; then
  fail_test "could not collect the nested dependency proof"
fi
if ! (cd "${scratch}" && bash scripts/evidence/collect.sh --gate nested) >"${tmp}/out.log" 2>&1; then
  fail_test "the composed collection failed"
fi
grep -Fq "composed" "${scratch}/evidence/state/nested.log" || fail_test "the collector did not compose the declared dependency proof"
record_py verify --gate nested >"${tmp}/out.log" 2>&1 || fail_test "the composed record does not verify"
if ! verify_gate --gate nested --profile default >"${tmp}/out.log" 2>&1; then
  fail_test "the CI entry point rejected the composed record"
fi
: >"${scratch}/evidence/state/nested.log"
if ! (cd "${scratch}" && "${python_bin}" scripts/evidence/validation_evidence.py run --gate nested --forced) >"${tmp}/out.log" 2>&1; then
  fail_test "the forced run failed"
fi
[[ "$(count_lines "${scratch}/evidence/state/nested.log")" == "1" ]] || fail_test "the forced run did not execute the gate"
grep -Fq "composed" "${scratch}/evidence/state/nested.log" && fail_test "the forced run consumed nested evidence"
"${python_bin}" - "${scratch}/evidence/nested/default.json" <<'PY' || fail_test "a forced record claimed nested composition"
import json
import sys

record = json.load(open(sys.argv[1], encoding="utf-8"))
assert record["verdict"] == "PASS", record
assert record["consumed"] == [], record["consumed"]
PY
record_py verify --gate nested >"${tmp}/out.log" 2>&1 || fail_test "the forced record does not verify"
pass_test "local composition consumes a verified dependency and forced execution never does"

# ---------------------------------------------------------------------------
# 6. The tracked registry keeps records in a nested evidence directory. The
#    fixture reads that directory from the real registry, so collection ->
#    verification exercises the real path shape instead of a one-segment
#    fixture that cannot see a path-shape mismatch.
# ---------------------------------------------------------------------------
real_registry="${repo_root}/scripts/evidence/validation-gates.json"
real_evidence_dir="$("${python_bin}" - "${real_registry}" <<'PY'
import json
import sys

print(json.load(open(sys.argv[1], encoding="utf-8"))["evidenceDirectory"].strip("/"))
PY
)"
[[ -n "${real_evidence_dir}" ]] || fail_test "the tracked registry declares no evidence directory"

nested_scratch="${tmp}/nested-repo"
nested_registry="${tmp}/nested-registry.json"
mkdir -p "${nested_scratch}/${real_evidence_dir}" "${nested_scratch}/src" \
  "${nested_scratch}/scripts/evidence"
"${python_bin}" - "${real_registry}" "${nested_registry}" "${live_environment_json}" "${real_evidence_dir}" <<'PY'
import json
import sys
from pathlib import Path

registry_path, nested_path, live_raw, evidence_dir = sys.argv[1:5]
probe = json.loads(live_raw)
live = {
    "go": probe["go"],
    "node": str(probe["node"]).lstrip("v").split(".")[0],
    "python": ".".join(str(probe["python"]).split(".")[:2]),
    "platform": probe["platform"],
}
data = json.loads(Path(registry_path).read_text(encoding="utf-8"))
data["evidenceDirectory"] = evidence_dir
data["localLogDirectory"] = f"{evidence_dir}/local"
data["proofProfiles"] = {"default": {"environment": live}}
data["gates"] = {
    "capture-nested": {
        "kind": "source",
        "environment": "toolchain",
        "profiles": ["default"],
        "resource": "cpu",
        "paths": ["src/"],
        "commands": [
            {
                "id": "capture-nested",
                "argv": ["python3", "scripts/job.py", "mark", f"{evidence_dir}/state/capture.log"],
            }
        ],
    }
}
Path(nested_path).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY

cp "${evidence_py}" "${nested_scratch}/scripts/evidence/validation_evidence.py"
cp "${nested_registry}" "${nested_scratch}/scripts/evidence/validation-gates.json"
cp "${repo_root}/scripts/evidence/verify-gate.sh" "${nested_scratch}/scripts/evidence/verify-gate.sh"
cp "${repo_root}/scripts/evidence/reuse-if-recorded.sh" "${nested_scratch}/scripts/evidence/reuse-if-recorded.sh"
cp "${repo_root}/scripts/evidence/collect.sh" "${nested_scratch}/scripts/evidence/collect.sh"
cp "${scratch}/bin/job.py" "${nested_scratch}/scripts/job.py"
printf 'one\n' >"${nested_scratch}/src/x.txt"
printf '1.0.0\n' >"${nested_scratch}/VERSION"
(
  cd "${nested_scratch}"
  git init -q -b main
  git config user.name "evidence-collection nested self-test"
  git config user.email "evidence-collection-nested@example.invalid"
  git config commit.gpgsign false
  git add -A
  git commit -q -m "fix: seed nested evidence fixture"
)

nested_record="${real_evidence_dir}/capture-nested/default.json"
if ! (cd "${nested_scratch}" && bash scripts/evidence/collect.sh --gate capture-nested) >"${tmp}/out.log" 2>&1; then
  fail_test "collection under the tracked nested evidence directory failed"
fi
[[ -f "${nested_scratch}/${nested_record}" ]] || fail_test "collection did not write the nested record path"
if ! (cd "${nested_scratch}" && bash scripts/evidence/verify-gate.sh --gate capture-nested --profile default) >"${tmp}/out.log" 2>&1; then
  fail_test "the CI entry point did not verify the nested record path"
fi
grep -Fq "evidence-verified" "${tmp}/out.log" || fail_test "the nested verification did not report verification"
[[ "$(count_lines "${nested_scratch}/${real_evidence_dir}/state/capture.log")" == "1" ]] || fail_test "the nested record was not produced exactly once"
pass_test "the tracked nested evidence path round-trips through collection and verification"

# ---------------------------------------------------------------------------
# 7. The workflows verify. No job uploads a produced record, no job carries a
#    force switch, and the only execution left is the generated release delta.
# ---------------------------------------------------------------------------
ci_workflow="${repo_root}/.github/workflows/ci.yml"
grep -Fq "scripts/evidence/verify-gate.sh" "${ci_workflow}" || fail_test "ci.yml lost the verify-only evidence entry point"
grep -Fq "produced-records" "${ci_workflow}" && fail_test "ci.yml still uploads produced records"
grep -Fq "EVIDENCE_FORCE_EXECUTE" "${ci_workflow}" && fail_test "ci.yml still carries a force-execution switch"
grep -Fq "validation_evidence.py run --gate release-delta --forced" "${ci_workflow}" || fail_test "ci.yml lost the generated release delta smoke"
[[ "$(grep -c "validation_evidence.py run " "${ci_workflow}")" == "1" ]] || fail_test "ci.yml executes more than the generated release delta"
pass_test "CI wiring verifies records and executes only the generated release delta"

echo "test-evidence-collection: PASS (${pass_count} checks)"
