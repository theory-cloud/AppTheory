#!/usr/bin/env bash
# Purpose: prove that the CI fallback really captures reusable evidence.
#
# Every case runs the real src/evidence/verify-or-execute.sh against a
# throwaway git repository with cheap, controlled commands. The assertions are
# about the actual record file, the actual command execution counters and the
# produced-record upload contract, not about a disconnected model:
#
#   * a first run executes once, writes a record with the real command, inputs
#     and environment, verifies, and a second identical run executes zero
#     commands;
#   * failed, cancelled and during-run-edited work is never published as PASS;
#   * a profile the host cannot produce is refused or replaced by a tracked
#     fallback, never mislabeled;
#   * the upload contract names the exact produced path and refuses a record
#     bundled with the checkout;
#   * forced execution never consumes nested proof.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python_bin="${PYTHON:-python3}"
evidence_py="${repo_root}/scripts/evidence/validation_evidence.py"

# These tests run from the rubric collector too, which exports the evidence
# environment for its own commands. The fixtures control their own reuse, force
# and manifest behavior, so inherited collector state must not leak in.
unset EVIDENCE_FORCE_EXECUTE APPTHEORY_EVIDENCE_REUSE APPTHEORY_EVIDENCE_PROFILE \
  APPTHEORY_EVIDENCE_CONSUME_LOG APPTHEORY_EVIDENCE_PRODUCED_MANIFEST

tmp="$(mktemp -d "${TMPDIR:-/tmp}/apptheory-evidence-capture.XXXXXX")"
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

live_environment_json="$("${python_bin}" "${evidence_py}" probe)"

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
cp "${repo_root}/scripts/evidence/verify-or-execute.sh" "${scratch}/scripts/evidence/verify-or-execute.sh"
cp "${repo_root}/scripts/evidence/reuse-if-recorded.sh" "${scratch}/scripts/evidence/reuse-if-recorded.sh"
cp "${repo_root}/scripts/evidence/collect.sh" "${scratch}/scripts/evidence/collect.sh"

(
  cd "${scratch}"
  git init -q -b main
  git config user.name "evidence-capture self-test"
  git config user.email "evidence-capture@example.invalid"
  git config commit.gpgsign false
  git add -A
  git commit -q -m "fix: seed execution-capture fixture"
)

pass_count=0
fail_test() {
  echo "test-evidence-execution-capture: FAIL ($1)" >&2
  if [[ -f "${tmp}/out.log" ]]; then
    cat "${tmp}/out.log" >&2
  fi
  exit 1
}
pass_test() {
  pass_count=$((pass_count + 1))
  echo "test-evidence-execution-capture: PASS $1"
}

wrapper() {
  (cd "${scratch}" && bash scripts/evidence/verify-or-execute.sh "$@")
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
# 1. Empty evidence dir: execute once, record the real command/inputs/host,
#    verify, then reuse with zero commands on an identical second run.
# ---------------------------------------------------------------------------
manifest="${tmp}/produced.txt"
: >"${manifest}"
if ! (cd "${scratch}" && APPTHEORY_EVIDENCE_PRODUCED_MANIFEST="${manifest}" bash scripts/evidence/verify-or-execute.sh --gate capture) >"${tmp}/out.log" 2>&1; then
  fail_test "first wrapper execution failed"
fi
grep -Fq "executing" "${tmp}/out.log" || fail_test "first wrapper run did not report execution"
record="${scratch}/evidence/capture/default.json"
[[ -f "${record}" ]] || fail_test "wrapper execution wrote no record"
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
grep -Fxq "evidence/capture/default.json" <(cut -f1 "${manifest}") || fail_test "producer manifest does not name the written record"
[[ "$(count_lines "${scratch}/evidence/state/capture.log")" == "1" ]] || fail_test "the command did not execute exactly once"
record_py verify --gate capture >"${tmp}/out.log" 2>&1 || fail_test "produced record does not verify on the same inputs/profile"
pass_test "execution writes a verifiable record with the real command, inputs and environment"

if ! (cd "${scratch}" && bash scripts/evidence/verify-or-execute.sh --gate capture) >"${tmp}/out.log" 2>&1; then
  fail_test "second wrapper run failed"
fi
grep -Fq "evidence-verified" "${tmp}/out.log" || fail_test "second wrapper run did not reuse the record"
grep -Fq "executing" "${tmp}/out.log" && fail_test "second wrapper run executed again"
[[ "$(count_lines "${scratch}/evidence/state/capture.log")" == "1" ]] || fail_test "second wrapper run re-executed the command"
pass_test "identical second wrapper run executes zero commands"

# The verifier never consults its own runner: a portable claim produced here is
# disclosed with its real environment and is verified against the tracked
# profile declaration, not against the host that runs the verifier.
if ! (cd "${scratch}" && bash scripts/evidence/collect.sh --gate capture --profile portable) >"${tmp}/out.log" 2>&1; then
  fail_test "could not collect the portable profile"
fi
record_py verify --gate capture --profile portable >"${tmp}/out.log" 2>&1 || fail_test "portable profile does not verify"
pass_test "local proof verification is independent of the verifier host"

# ---------------------------------------------------------------------------
# 2. Failed, cancelled and during-run-edited work is never published as PASS.
# ---------------------------------------------------------------------------
if wrapper --gate failing >"${tmp}/out.log" 2>&1; then
  fail_test "a failing command returned success"
fi
grep -Fq '"verdict": "FAIL"' "${scratch}/evidence/failing/default.json" || fail_test "failed command did not retain a FAIL record"
record_py verify --gate failing >"${tmp}/out.log" 2>&1 && fail_test "a FAIL record verified as reusable"
if wrapper --gate failing >"${tmp}/out.log" 2>&1; then
  fail_test "a failed gate re-run returned success"
fi
grep -Fq "evidence-verified" "${tmp}/out.log" && fail_test "a failed gate reused a FAIL record"
[[ "$(count_lines "${scratch}/evidence/state/failing.log")" == "2" ]] || fail_test "a failed gate was not re-executed"
pass_test "failed work is retained as FAIL and never reused"

if wrapper --gate mutator >"${tmp}/out.log" 2>&1; then
  fail_test "a during-run edit returned success"
fi
grep -Fq "changed during the run" "${scratch}/evidence/mutator/default.json" || fail_test "a during-run edit was not recorded as tainted"
grep -Fq '"verdict": "FAIL"' "${scratch}/evidence/mutator/default.json" || fail_test "a tainted record was not FAIL"
record_py verify --gate mutator >"${tmp}/out.log" 2>&1 && fail_test "a tainted record verified as reusable"
(cd "${scratch}" && git checkout -q -- src/x.txt)
pass_test "a changed input during execution is tainted and refused"

(cd "${scratch}" && exec bash scripts/evidence/verify-or-execute.sh --gate slow) >"${tmp}/cancel.log" 2>&1 &
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
# 3. Wrong producing environment: refuse or use only a tracked fallback, with
#    truthful attribution. Nothing is labeled with a profile this host is not.
# ---------------------------------------------------------------------------
record_py verify --gate platform-bound --profile foreign >"${tmp}/out.log" 2>&1 && fail_test "a missing profile record verified"
if ! wrapper --gate platform-bound --profile foreign >"${tmp}/out.log" 2>&1; then
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
if ! wrapper --gate platform-bound --profile foreign >"${tmp}/out.log" 2>&1; then
  fail_test "second fallback run failed"
fi
grep -Fq "evidence-verified" "${tmp}/out.log" || fail_test "the fallback record was not reused"
grep -Fq "fallback" "${tmp}/out.log" || fail_test "the reuse line did not name the fallback profile"
[[ "$(count_lines "${scratch}/evidence/state/platform.log")" == "1" ]] || fail_test "the fallback proof was re-executed"
pass_test "a host that cannot produce the requested profile uses a tracked, truthfully labeled fallback"

if wrapper --gate unproducible --profile foreign >"${tmp}/out.log" 2>&1; then
  fail_test "an unsatisfiable profile was accepted"
fi
grep -Fq "cannot be produced on this host" "${tmp}/out.log" || fail_test "the unsatisfiable profile was not refused clearly"
[[ -f "${scratch}/evidence/unproducible/foreign.json" ]] && fail_test "an unsatisfiable profile wrote a record"
if wrapper --gate unproducible --profile foreign --verify-only >"${tmp}/out.log" 2>&1; then
  fail_test "an unsatisfiable profile reported reusable evidence"
fi
pass_test "an unsatisfiable profile is refused without false provenance"

# ---------------------------------------------------------------------------
# 4. CI upload contract: the exact produced path, never a stale checkout
#    record and never a silent glob.
# ---------------------------------------------------------------------------
gh_output="${tmp}/github-output.txt"
: >"${gh_output}"
if ! (cd "${scratch}" && GITHUB_OUTPUT="${gh_output}" "${python_bin}" scripts/evidence/validation_evidence.py produced-records --manifest "${manifest}") >"${tmp}/out.log" 2>&1; then
  fail_test "the produced-record contract rejected a real produced record"
fi
grep -Fxq "evidence/capture/default.json" "${gh_output}" || fail_test "the upload path does not name the produced record"
grep -Fxq "any=true" "${gh_output}" || fail_test "the upload contract did not report produced records"
pass_test "the upload contract names the produced record path"

printf 'evidence/capture/ghost.json\n' >"${tmp}/missing-manifest.txt"
(cd "${scratch}" && "${python_bin}" scripts/evidence/validation_evidence.py produced-records --manifest "${tmp}/missing-manifest.txt") >"${tmp}/out.log" 2>&1 && fail_test "a missing produced record was uploaded"
printf 'src/x.txt\n' >"${tmp}/foreign-manifest.txt"
(cd "${scratch}" && "${python_bin}" scripts/evidence/validation_evidence.py produced-records --manifest "${tmp}/foreign-manifest.txt") >"${tmp}/out.log" 2>&1 && fail_test "a non-record path was uploaded"
: >"${tmp}/empty-manifest.txt"
: >"${gh_output}"
(cd "${scratch}" && GITHUB_OUTPUT="${gh_output}" "${python_bin}" scripts/evidence/validation_evidence.py produced-records --manifest "${tmp}/empty-manifest.txt") >"${tmp}/out.log" 2>&1 || fail_test "an empty producer manifest failed instead of reporting nothing"
grep -Fxq "any=false" "${gh_output}" || fail_test "an empty producer manifest did not report no records"
pass_test "the upload contract fails closed on missing or foreign paths and reports nothing produced"

if (cd "${scratch}" && env -u APPTHEORY_EVIDENCE_PRODUCED_MANIFEST "${python_bin}" scripts/evidence/validation_evidence.py produced-records --require-manifest) >"${tmp}/out.log" 2>&1; then
  fail_test "the CI contract accepted a job with no producer manifest configured"
fi
grep -Fq "no producer manifest is configured" "${tmp}/out.log" || fail_test "a missing producer manifest was not refused clearly"
pass_test "the CI contract requires a configured producer manifest"

(
  cd "${scratch}"
  git add evidence/capture/default.json
  git commit -q -m "fix: commit a produced record"
)
(cd "${scratch}" && "${python_bin}" scripts/evidence/validation_evidence.py produced-records --manifest "${manifest}") >"${tmp}/out.log" 2>&1 && fail_test "a checkout-bundled record was uploaded as new proof"
grep -Fq "bundled with the checkout" "${tmp}/out.log" || fail_test "a checkout-bundled record was not called out"
pass_test "a record bundled with the checkout is not published as new proof"

# A stale committed record is a different case: when this run really replaces
# it, the produced path is the checkout path and must be uploadable. The
# producer digest and the checkout diff distinguish the two.
printf 'two\n' >>"${scratch}/src/x.txt"
(
  cd "${scratch}"
  git add src/x.txt
  git commit -q -m "fix: change a validated input"
)
refreshed_manifest="${tmp}/refreshed.txt"
: >"${refreshed_manifest}"
if ! (cd "${scratch}" && APPTHEORY_EVIDENCE_PRODUCED_MANIFEST="${refreshed_manifest}" bash scripts/evidence/verify-or-execute.sh --gate capture) >"${tmp}/out.log" 2>&1; then
  fail_test "refreshing a stale committed record failed"
fi
grep -Fq "executing" "${tmp}/out.log" || fail_test "a stale committed record was reused as current proof"
: >"${gh_output}"
if ! (cd "${scratch}" && GITHUB_OUTPUT="${gh_output}" "${python_bin}" scripts/evidence/validation_evidence.py produced-records --manifest "${refreshed_manifest}") >"${tmp}/out.log" 2>&1; then
  fail_test "a record this run replaced was refused as checkout-bundled"
fi
grep -Fxq "evidence/capture/default.json" <(grep -v '^any=' "${gh_output}") || fail_test "the refreshed record path was not uploaded"
(
  cd "${scratch}"
  git add evidence/capture/default.json
  git commit -q -m "fix: refresh the produced record"
)
pass_test "a stale committed record replaced by this run is a produced record"

# ---------------------------------------------------------------------------
# 6. The tracked registry keeps records in a nested evidence directory. The
#    fixture reads that directory from the real registry, so capture ->
#    produced-records exercises the real path shape instead of a one-segment
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
cp "${repo_root}/scripts/evidence/verify-or-execute.sh" "${nested_scratch}/scripts/evidence/verify-or-execute.sh"
cp "${repo_root}/scripts/evidence/reuse-if-recorded.sh" "${nested_scratch}/scripts/evidence/reuse-if-recorded.sh"
cp "${repo_root}/scripts/evidence/collect.sh" "${nested_scratch}/scripts/evidence/collect.sh"
cp "${scratch}/bin/job.py" "${nested_scratch}/scripts/job.py"
printf 'one\n' >"${nested_scratch}/src/x.txt"
printf '1.0.0\n' >"${nested_scratch}/VERSION"
(
  cd "${nested_scratch}"
  git init -q -b main
  git config user.name "evidence-capture nested self-test"
  git config user.email "evidence-capture-nested@example.invalid"
  git config commit.gpgsign false
  git add -A
  git commit -q -m "fix: seed nested evidence fixture"
)

nested_manifest="${tmp}/nested-produced.txt"
: >"${nested_manifest}"
nested_record="${real_evidence_dir}/capture-nested/default.json"
if ! (cd "${nested_scratch}" && APPTHEORY_EVIDENCE_PRODUCED_MANIFEST="${nested_manifest}" bash scripts/evidence/verify-or-execute.sh --gate capture-nested) >"${tmp}/out.log" 2>&1; then
  fail_test "capture under the tracked nested evidence directory failed"
fi
[[ -f "${nested_scratch}/${nested_record}" ]] || fail_test "capture did not write the nested record path"
grep -Fxq "${nested_record}" <(cut -f1 "${nested_manifest}") || fail_test "the producer manifest does not name the nested record"

nested_gh_output="${tmp}/nested-github-output.txt"
: >"${nested_gh_output}"
if ! (cd "${nested_scratch}" && GITHUB_OUTPUT="${nested_gh_output}" "${python_bin}" scripts/evidence/validation_evidence.py produced-records --manifest "${nested_manifest}") >"${tmp}/out.log" 2>&1; then
  fail_test "the produced-record contract rejected the tracked nested evidence directory"
fi
nested_paths="$(grep -F ".json" "${nested_gh_output}" || true)"
[[ "${nested_paths}" == "${nested_record}" ]] || fail_test "the upload contract did not report exactly the newly produced nested record"
grep -Fxq "any=true" "${nested_gh_output}" || fail_test "the nested upload contract did not report produced records"

if ! (cd "${nested_scratch}" && bash scripts/evidence/verify-or-execute.sh --gate capture-nested) >"${tmp}/out.log" 2>&1; then
  fail_test "second nested wrapper run failed"
fi
grep -Fq "evidence-verified" "${tmp}/out.log" || fail_test "second nested wrapper run did not reuse the record"
grep -Fq "executing" "${tmp}/out.log" && fail_test "second nested wrapper run executed again"
[[ "$(count_lines "${nested_scratch}/${real_evidence_dir}/state/capture.log")" == "1" ]] || fail_test "the nested record was not produced exactly once"

printf 'evidence/capture-nested/default.json\n' >"${tmp}/nested-outside.txt"
(cd "${nested_scratch}" && "${python_bin}" scripts/evidence/validation_evidence.py produced-records --manifest "${tmp}/nested-outside.txt") >"${tmp}/out.log" 2>&1 && fail_test "a path outside the tracked nested evidence directory was uploaded"
printf '%s/../capture-nested/default.json\n' "${real_evidence_dir}" >"${tmp}/nested-traversal.txt"
(cd "${nested_scratch}" && "${python_bin}" scripts/evidence/validation_evidence.py produced-records --manifest "${tmp}/nested-traversal.txt") >"${tmp}/out.log" 2>&1 && fail_test "a traversal path under the nested evidence directory was uploaded"
printf '%s\tsha256:0000000000000000000000000000000000000000000000000000000000000000\n' "${nested_record}" >"${tmp}/nested-digest.txt"
(cd "${nested_scratch}" && "${python_bin}" scripts/evidence/validation_evidence.py produced-records --manifest "${tmp}/nested-digest.txt") >"${tmp}/out.log" 2>&1 && fail_test "a nested record with the wrong digest was uploaded"
pass_test "the tracked nested evidence path round-trips through capture and the upload contract"

# The workflow must use the produced-record contract, not the old glob.
ci_workflow="${repo_root}/.github/workflows/ci.yml"
grep -Fq "validation_evidence.py produced-records --require-manifest" "${ci_workflow}" || fail_test "ci.yml lost the produced-record contract"
grep -Fq 'path: ${{ steps.produced.outputs.paths }}' "${ci_workflow}" || fail_test "ci.yml does not upload the produced paths"
grep -Fq "if-no-files-found: error" "${ci_workflow}" || fail_test "ci.yml does not require the produced record"
grep -Fq "if-no-files-found: ignore" "${ci_workflow}" && fail_test "ci.yml still silently ignores missing records"
pass_test "CI wiring requires the produced record instead of a glob"

# ---------------------------------------------------------------------------
# 5. Forced and unclassified execution stays independent of nested proof.
# ---------------------------------------------------------------------------
if ! record_py collect --gate nested-dep >"${tmp}/out.log" 2>&1; then
  fail_test "could not collect the nested dependency proof"
fi
: >"${scratch}/evidence/state/nested.log"
if ! wrapper --gate nested >"${tmp}/out.log" 2>&1; then
  fail_test "the composed wrapper run failed"
fi
grep -Fq "composed from nested-dep" "${tmp}/out.log" || fail_test "the wrapper did not compose the declared dependency proof"
[[ "$(count_lines "${scratch}/evidence/state/nested.log")" == "0" ]] || fail_test "a composed wrapper run executed the gate"
: >"${scratch}/evidence/state/nested.log"
if ! (cd "${scratch}" && EVIDENCE_FORCE_EXECUTE=true bash scripts/evidence/verify-or-execute.sh --gate nested) >"${tmp}/out.log" 2>&1; then
  fail_test "the forced wrapper run failed"
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
pass_test "forced execution writes a record independent of nested proof"

printf 'unclassified\n' >"${scratch}/unclassified.txt"
(
  cd "${scratch}"
  git add unclassified.txt
  git commit -q -m "fix: add an unclassified input"
)
if wrapper --gate capture >"${tmp}/out.log" 2>&1; then
  fail_test "an unclassified input produced a green gate"
fi
grep -Fq "unknown inputs require broad validation" "${scratch}/evidence/capture/default.json" || fail_test "an unclassified input was not retained honestly"
record_py verify --gate capture >"${tmp}/out.log" 2>&1 && fail_test "a record with unclassified inputs verified"
(
  cd "${scratch}"
  rm -f unclassified.txt
  git add -A
  git commit -q -m "fix: drop the unclassified input"
)
pass_test "an unclassified input is refused instead of recorded as a reusable PASS"

# The producer manifest lists the records this run wrote and their digests.
# A fresh manifest is created by this process, so it must be owner-only:
# another local account must not be able to read or rewrite the upload list.
mode_manifest="${tmp}/mode-manifest.txt"
rm -f "${mode_manifest}"
if ! (cd "${scratch}" && APPTHEORY_EVIDENCE_PRODUCED_MANIFEST="${mode_manifest}" EVIDENCE_FORCE_EXECUTE=true bash scripts/evidence/verify-or-execute.sh --gate capture) >"${tmp}/out.log" 2>&1; then
  fail_test "creating a fresh producer manifest failed"
fi
"${python_bin}" - "${mode_manifest}" <<'PY' || fail_test "a fresh producer manifest is not owner-only"
import os
import sys

mode = os.stat(sys.argv[1]).st_mode & 0o777
assert mode == 0o600, oct(mode)
PY
pass_test "a fresh producer manifest is created owner-only"

echo "test-evidence-execution-capture: PASS (${pass_count} checks)"
