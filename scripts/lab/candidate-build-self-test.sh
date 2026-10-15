#!/usr/bin/env bash
# Purpose: offline self-test for scripts/lab/candidate-build.sh.
#
# The self-test is network-free, makes no AWS calls and uses no credentials. It builds a
# throwaway fixture git repository (mktemp -d, removed on exit) that carries stand-in
# implementations of the four per-surface build entry points:
#
#   scripts/verify-cdk-ts-pack.sh, scripts/verify-ts-pack.sh,
#   scripts/verify-python-build.sh, scripts/verify-cdk-python-build.sh
#
# Those stand-ins exist because the real builds need the network (npm ci / pip / jsii-pacmak).
# They deterministically create the expected artifact files under dist/ with `gzip -n`, so they
# are byte-stable across runs. This self-test therefore exercises the builder's config parsing,
# repo binding, stage allowlist, environment refusal, the declared-surface-subset contract (a
# declared subset is built and an undeclared surface is never built, an unknown surface key or
# a non-annotation per-surface field is refused), the whole git-archive attribute class (a
# committed `export-ignore` or `export-subst` .gitattributes is refused by name, and the
# entry-list and blob-content comparisons still refuse an attribute applied from outside the
# tree), per-surface hash verification, artifact handling and receipt -- it does NOT re-test the
# real npm/python builds.
# One case asserts that REPO itself ships the real build scripts so the fixture cannot drift
# away from reality, and one runs the real builder against this repository's own tree (offline,
# S1 only), so the archive checks are proven not to refuse a real tree.
#
# Usage: bash scripts/lab/candidate-build-self-test.sh
# Prints: candidate-build: self-test PASS (N cases)  |  candidate-build: self-test FAIL (<case>)

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
builder="${script_dir}/candidate-build.sh"
example_config="${repo_root}/docs/development/planning/apptheory/mcp-auth-facade/fixtures/candidate-stage-lab.example.json"

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

fixture="${tmp}/fixture"
witness_dir="${tmp}/witness"
witness_json="${tmp}/witness.json"

current_case=""
cases_passed=0

case_fail() {
  printf 'candidate-build: self-test FAIL (%s)\n' "${current_case}" >&2
  printf '  %s\n' "$1" >&2
  exit 1
}

case_start() { current_case="$1"; }
case_pass() {
  cases_passed=$((cases_passed + 1))
  printf '  PASS %s\n' "${current_case}"
}

builder_status=0
builder_stdout=""
builder_stderr=""

run_builder() {
  set +e
  builder_stdout="$("$@" 2> "${tmp}/stderr.txt")"
  builder_status=$?
  set -e
  builder_stderr="$(cat "${tmp}/stderr.txt")"
}

assert_status() {
  [[ "${builder_status}" -eq "$1" ]] || case_fail "expected exit $1, got ${builder_status}"$'\n'"stdout: ${builder_stdout}"$'\n'"stderr: ${builder_stderr}"
}

assert_stderr_contains() {
  [[ "${builder_stderr}" == *"$1"* ]] || case_fail "stderr does not contain '$1'"$'\n'"stderr: ${builder_stderr}"
}

make_fixture() {
  mkdir -p "${fixture}/scripts" "${fixture}/cdk" "${fixture}/ts" "${fixture}/py" "${fixture}/cdk-go/apptheorycdk"

  printf 'dist/\n' > "${fixture}/.gitignore"
  printf '# fixture repository for the candidate-build self-test\n' > "${fixture}/README.md"
  printf '{"name":"fixture-cdk","version":"9.9.9"}\n' > "${fixture}/cdk/package.json"
  printf '{"name":"fixture-ts-runtime","version":"9.9.9"}\n' > "${fixture}/ts/package.json"
  printf '[project]\nname = "fixture-py"\nversion = "9.9.9"\n' > "${fixture}/py/pyproject.toml"
  printf 'module github.com/example/apptheory/cdk-go/apptheorycdk/v6\n\ngo 1.26.5\n' > "${fixture}/cdk-go/apptheorycdk/go.mod"
  # A file carrying an export-subst placeholder, so a fixture commit can reproduce the
  # `export-subst` attack ($Format:%H$ -> the substituted commit id) as well as the
  # `export-ignore` one. With no attribute set its archived bytes equal its blob.
  printf 'commit %s\n' '$Format:%H$' > "${fixture}/VERSION-TEMPLATE.txt"

  cat > "${fixture}/scripts/read-version.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "9.9.9"
EOF

  cat > "${fixture}/scripts/verify-cdk-ts-pack.sh" <<'EOF'
#!/usr/bin/env bash
# Stand-in for the real npm CDK pack build: deterministic, network-free.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p dist
printf 'standin npm-cdk 9.9.9\n' | gzip -n > dist/theory-cloud-apptheory-cdk-9.9.9.tgz
EOF

  cat > "${fixture}/scripts/verify-ts-pack.sh" <<'EOF'
#!/usr/bin/env bash
# Stand-in for the real npm TS runtime pack build: deterministic, network-free.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p dist
printf 'standin npm-ts-runtime 9.9.9\n' | gzip -n > dist/theory-cloud-apptheory-9.9.9.tgz
EOF

  cat > "${fixture}/scripts/verify-python-build.sh" <<'EOF'
#!/usr/bin/env bash
# Stand-in for the real python runtime build: deterministic, network-free; one run
# produces both the wheel and the sdist.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p dist
printf 'standin py-runtime-wheel 9.9.9\n' | gzip -n > dist/apptheory-9.9.9-py3-none-any.whl
printf 'standin py-runtime-sdist 9.9.9\n' | gzip -n > dist/apptheory-9.9.9.tar.gz
EOF

  cat > "${fixture}/scripts/verify-cdk-python-build.sh" <<'EOF'
#!/usr/bin/env bash
# Stand-in for the real jsii python CDK build: deterministic, network-free.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p dist
printf 'standin py-cdk-wheel 9.9.9\n' | gzip -n > dist/apptheory_cdk-9.9.9-py3-none-any.whl
EOF

  chmod +x "${fixture}/scripts/"*.sh

  git -C "${fixture}" init -q
  git -C "${fixture}" config user.email "candidate-build-self-test@example.invalid"
  git -C "${fixture}" config user.name "candidate-build self-test"
  git -C "${fixture}" config commit.gpgsign false
  git -C "${fixture}" add -A
  git -C "${fixture}" commit -q -m "fixture: candidate build inputs"
}

witness_build() {
  rm -rf "${witness_dir}"
  mkdir -p "${witness_dir}"

  git -C "${fixture}" archive --format=tar --output="${witness_dir}/go_runtime.tar" "${fixture_commit}" -- . ':(exclude)cdk-go'
  git -C "${fixture}" archive --format=tar --output="${witness_dir}/go_cdk.tar" "${fixture_commit}" -- cdk-go/apptheorycdk

  ( cd "${fixture}" && ./scripts/verify-cdk-ts-pack.sh )
  ( cd "${fixture}" && ./scripts/verify-ts-pack.sh )
  ( cd "${fixture}" && ./scripts/verify-python-build.sh )
  ( cd "${fixture}" && ./scripts/verify-cdk-python-build.sh )

  cp "${fixture}/dist/theory-cloud-apptheory-cdk-9.9.9.tgz" "${witness_dir}/"
  cp "${fixture}/dist/theory-cloud-apptheory-9.9.9.tgz" "${witness_dir}/"
  cp "${fixture}/dist/apptheory-9.9.9-py3-none-any.whl" "${witness_dir}/"
  cp "${fixture}/dist/apptheory-9.9.9.tar.gz" "${witness_dir}/"
  cp "${fixture}/dist/apptheory_cdk-9.9.9-py3-none-any.whl" "${witness_dir}/"

  python3 - "${witness_dir}" "${witness_json}" "${fixture_commit}" "${fixture_tree}" "${fixture_epoch}" <<'PY'
import base64
import hashlib
import json
import os
import sys

wdir, out_path, commit, tree, epoch = sys.argv[1:6]


def sha256_of(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def integrity_of(path):
    return "sha512-" + base64.b64encode(hashlib.sha512(open(path, "rb").read()).digest()).decode()


def locate(name):
    return os.path.join(wdir, name)


data = {
    "commit": commit,
    "tree": tree,
    "source_date_epoch": int(epoch),
    "surfaces": {
        "go_runtime": {"sha256": sha256_of(locate("go_runtime.tar"))},
        "go_cdk": {"sha256": sha256_of(locate("go_cdk.tar"))},
        "npm_cdk": {
            "file": "theory-cloud-apptheory-cdk-9.9.9.tgz",
            "sha256": sha256_of(locate("theory-cloud-apptheory-cdk-9.9.9.tgz")),
            "integrity": integrity_of(locate("theory-cloud-apptheory-cdk-9.9.9.tgz")),
        },
        "npm_ts_runtime": {
            "file": "theory-cloud-apptheory-9.9.9.tgz",
            "sha256": sha256_of(locate("theory-cloud-apptheory-9.9.9.tgz")),
            "integrity": integrity_of(locate("theory-cloud-apptheory-9.9.9.tgz")),
        },
        "py_runtime_wheel": {
            "file": "apptheory-9.9.9-py3-none-any.whl",
            "sha256": sha256_of(locate("apptheory-9.9.9-py3-none-any.whl")),
        },
        "py_runtime_sdist": {
            "file": "apptheory-9.9.9.tar.gz",
            "sha256": sha256_of(locate("apptheory-9.9.9.tar.gz")),
        },
        "py_cdk_wheel": {
            "file": "apptheory_cdk-9.9.9-py3-none-any.whl",
            "sha256": sha256_of(locate("apptheory_cdk-9.9.9-py3-none-any.whl")),
        },
    },
}

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2, sort_keys=True)
PY
}

write_config() {
  local path="$1"
  local stage="$2"
  local commit_override="${3:-}"
  local tree_override="${4:-}"
  local epoch_override="${5:-}"
  python3 - "${witness_json}" "${path}" "${stage}" "${commit_override}" "${tree_override}" "${epoch_override}" <<'PY'
import json
import sys

witness = json.load(open(sys.argv[1]))
out = sys.argv[2]
stage = sys.argv[3]
commit_override, tree_override, epoch_override = sys.argv[4], sys.argv[5], sys.argv[6]

doc = {
    "stage": stage,
    "expected_account_id": "123456789012",
    "apptheory": {
        "candidate": {
            # The overrides let a case bind a later fixture commit (for example one whose
            # stand-in build script fails) while keeping the witnessed surface map.
            "commit": commit_override or witness["commit"],
            "tree": tree_override or witness["tree"],
            "source_date_epoch": int(epoch_override) if epoch_override else witness["source_date_epoch"],
            "surfaces": witness["surfaces"],
        }
    },
}

with open(out, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
}

snapshot_dir() {
  python3 - "$1" <<'PY'
import hashlib
import os
import sys

root = sys.argv[1]
if not os.path.isdir(root):
    print("MISSING")
    raise SystemExit(0)
for name in sorted(os.listdir(root)):
    path = os.path.join(root, name)
    if os.path.isfile(path):
        print(name, hashlib.sha256(open(path, "rb").read()).hexdigest())
PY
}

make_fixture
fixture_commit="$(git -C "${fixture}" rev-parse HEAD)"
fixture_tree="$(git -C "${fixture}" rev-parse "HEAD^{tree}")"
fixture_epoch="$(git -C "${fixture}" show -s --format=%ct HEAD)"

witness_build

echo "candidate-build: self-test"

# --- case: REPO ships the real build scripts -------------------------------------------
case_start "repo ships the four real build scripts"
for rel in \
  scripts/read-version.sh \
  scripts/verify-cdk-ts-pack.sh \
  scripts/verify-ts-pack.sh \
  scripts/verify-python-build.sh \
  scripts/verify-cdk-python-build.sh; do
  [[ -f "${repo_root}/${rel}" ]] || case_fail "repository is missing ${rel}"
done
[[ -f "${builder}" ]] || case_fail "repository is missing scripts/lab/candidate-build.sh"
[[ -f "${example_config}" ]] || case_fail "repository is missing the example config ${example_config}"
case_pass

# --- case 1: valid lab config builds and verifies --------------------------------------
case_start "valid lab config builds and verifies"
cfg_valid="${tmp}/cfg-valid.json"
write_config "${cfg_valid}" "lab"
out1="${tmp}/out1"
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_valid}" --out "${out1}"
assert_status 0
for artifact in \
  go_runtime.tar \
  go_cdk.tar \
  theory-cloud-apptheory-cdk-9.9.9.tgz \
  theory-cloud-apptheory-9.9.9.tgz \
  apptheory-9.9.9-py3-none-any.whl \
  apptheory-9.9.9.tar.gz \
  apptheory_cdk-9.9.9-py3-none-any.whl; do
  [[ -f "${out1}/${artifact}" ]] || case_fail "missing verified artifact in --out: ${artifact}"
done
receipt1="${out1}/candidate-receipt.json"
[[ -f "${receipt1}" ]] || case_fail "missing receipt: ${receipt1}"
python3 - "${receipt1}" "${out1}" "${witness_json}" <<'PY'
import hashlib
import json
import os
import sys

receipt = json.load(open(sys.argv[1]))
out = sys.argv[2]
witness = json.load(open(sys.argv[3]))

assert receipt["schema"] == "apptheory.candidate-receipt/v1", receipt.get("schema")
assert receipt["builder"] == "scripts/lab/candidate-build.sh", receipt.get("builder")
assert len(receipt["surfaces"]) == 7, len(receipt["surfaces"])
assert set(receipt["commands"]) == set(receipt["surfaces"])

bad = []


def walk(node, path=""):
    if isinstance(node, dict):
        for key, value in node.items():
            if "timestamp" in key.lower() or key.lower() in ("generated_at", "created_at"):
                bad.append(path + "/" + key)
            walk(value, path + "/" + key)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            walk(value, f"{path}[{index}]")


walk(receipt)
assert not bad, f"receipt carries timestamp field(s): {bad}"

for name, entry in receipt["surfaces"].items():
    artifact = os.path.join(out, entry["artifact"])
    assert os.path.isfile(artifact), artifact
    fresh = hashlib.sha256(open(artifact, "rb").read()).hexdigest()
    assert fresh == entry["sha256"], (name, fresh, entry["sha256"])
    assert entry["sha256"] == witness["surfaces"][name]["sha256"], name
PY
last_line="$(printf '%s\n' "${builder_stdout}" | tail -n 1)"
[[ "${last_line}" == "candidate-build: PASS (lab ${fixture_commit}; 7 surfaces verified)" ]] \
  || case_fail "final PASS line mismatch: ${last_line}"
case_pass

# --- case 2: tampered tarball hash fails -----------------------------------------------
case_start "tampered tarball hash fails"
cfg_tampered="${tmp}/cfg-tampered.json"
write_config "${cfg_tampered}" "lab"
python3 - "${cfg_tampered}" <<'PY'
import json
import sys

path = sys.argv[1]
doc = json.load(open(path))
surface = doc["apptheory"]["candidate"]["surfaces"]["npm_cdk"]
sha = surface["sha256"]
surface["sha256"] = ("0" if sha[0] != "0" else "1") + sha[1:]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
out2="${tmp}/out2"
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_tampered}" --out "${out2}"
assert_status 1
assert_stderr_contains "surface npm_cdk hash mismatch"
[[ ! -f "${out2}/theory-cloud-apptheory-cdk-9.9.9.tgz" ]] || case_fail "tampered artifact was left in --out"
case_pass

# --- case 3: wrong tree fails ----------------------------------------------------------
case_start "wrong tree fails"
cfg_tree="${tmp}/cfg-tree.json"
write_config "${cfg_tree}" "lab"
python3 - "${cfg_tree}" <<'PY'
import json
import sys

path = sys.argv[1]
doc = json.load(open(path))
doc["apptheory"]["candidate"]["tree"] = "0" * 40
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_tree}" --out "${tmp}/out3"
assert_status 1
assert_stderr_contains "0000000000000000000000000000000000000000"
assert_stderr_contains "${fixture_tree}"
case_pass

# --- case 4: live / staging stages are refused -----------------------------------------
case_start "live stage is refused"
for stage in live staging; do
  write_config "${tmp}/cfg-stage-${stage}.json" "${stage}"
  run_builder bash "${builder}" --repo "${fixture}" --config "${tmp}/cfg-stage-${stage}.json" --out "${tmp}/out-stage-${stage}"
  assert_status 1
  assert_stderr_contains "stage '${stage}'"
  assert_stderr_contains "lab is the only allowed candidate stage"
  assert_stderr_contains "a live config carries no candidate block"
done
case_pass

# --- case 5: a declared surface with no witness hash fails ------------------------------
case_start "a declared surface with no witness hash fails"
cfg_missing="${tmp}/cfg-missing.json"
write_config "${cfg_missing}" "lab"
python3 - "${cfg_missing}" <<'PY'
import json
import sys

path = sys.argv[1]
doc = json.load(open(path))
# The surface stays declared, so it must be built and verified; without its witnessed
# hash the builder refuses before building anything.
del doc["apptheory"]["candidate"]["surfaces"]["py_cdk_wheel"]["sha256"]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_missing}" --out "${tmp}/out5"
assert_status 1
assert_stderr_contains "declared surface 'py_cdk_wheel' is missing a non-empty sha256"
case_pass

# --- case 6: environment-only candidate input is refused -------------------------------
case_start "environment-only candidate input is refused"
printf '{"stage":"lab","expected_account_id":"123456789012"}\n' > "${tmp}/cfg-nocandidate.json"
run_builder env APPTHEORY_CANDIDATE_COMMIT=deadbeef APPTHEORY_CANDIDATE_TREE=cafebabe \
  bash "${builder}" --repo "${fixture}" --config "${tmp}/cfg-nocandidate.json" --out "${tmp}/out6a"
assert_status 1
assert_stderr_contains "environment input is not allowed"
assert_stderr_contains "APPTHEORY_CANDIDATE_COMMIT"

run_builder env APPTHEORY_CANDIDATE_COMMIT=deadbeef APPTHEORY_CANDIDATE_TREE=cafebabe \
  bash "${builder}" --repo "${fixture}" --config "${cfg_valid}" --out "${tmp}/out6b"
assert_status 1
assert_stderr_contains "environment input is not allowed"
assert_stderr_contains "APPTHEORY_CANDIDATE_TREE"
case_pass

# --- case 7: dirty tree fails ----------------------------------------------------------
case_start "dirty tree fails"
printf 'uncommitted scratch\n' > "${fixture}/scratch-dirty.txt"
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_valid}" --out "${tmp}/out7"
assert_status 1
assert_stderr_contains "working tree is dirty"
assert_stderr_contains "scratch-dirty.txt"
rm -f "${fixture}/scratch-dirty.txt"
case_pass

# --- case 8: a commit that is not HEAD fails -------------------------------------------
case_start "a commit that is not HEAD fails"
printf 'second change\n' >> "${fixture}/README.md"
git -C "${fixture}" add -A
git -C "${fixture}" commit -q -m "fixture: second change"
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_valid}" --out "${tmp}/out8"
assert_status 1
assert_stderr_contains "does not equal encoded commit '${fixture_commit}'"
git -C "${fixture}" reset -q --hard "${fixture_commit}"
case_pass

# --- case 9: account mismatch fails ----------------------------------------------------
case_start "account mismatch fails"
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_valid}" --out "${tmp}/out9" --account-id 000000000000
assert_status 1
assert_stderr_contains "000000000000"
assert_stderr_contains "123456789012"
case_pass

# --- case 10: print-plan validates but builds nothing ----------------------------------
case_start "print-plan validates but builds nothing"
receipts_before="$(find "${tmp}" -name 'candidate-receipt.json' | wc -l | tr -d ' ')"
dist_before="$(snapshot_dir "${fixture}/dist")"
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_valid}" --print-plan
assert_status 0
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_valid}" --print-plan --out "${tmp}/out-plan"
assert_status 0
[[ ! -e "${tmp}/out-plan" ]] || case_fail "--print-plan created the --out directory ${tmp}/out-plan"
receipts_after="$(find "${tmp}" -name 'candidate-receipt.json' | wc -l | tr -d ' ')"
[[ "${receipts_before}" == "${receipts_after}" ]] || case_fail "print-plan wrote a receipt (${receipts_before} -> ${receipts_after})"
dist_after="$(snapshot_dir "${fixture}/dist")"
[[ "${dist_before}" == "${dist_after}" ]] || case_fail "print-plan modified the fixture dist/"
case_pass

# --- case 11: the runnable example config parses ---------------------------------------
case_start "the runnable example config parses"
cfg_example="${tmp}/cfg-example.json"
python3 - "${example_config}" "${cfg_example}" "${witness_json}" <<'PY'
import json
import sys

example = json.load(open(sys.argv[1]))
out = sys.argv[2]
witness = json.load(open(sys.argv[3]))

candidate = example["apptheory"]["candidate"]
candidate["commit"] = witness["commit"]
candidate["tree"] = witness["tree"]
candidate["source_date_epoch"] = witness["source_date_epoch"]
for name, entry in witness["surfaces"].items():
    surface = candidate["surfaces"][name]
    for key, value in entry.items():
        surface[key] = value

with open(out, "w", encoding="utf-8") as handle:
    json.dump(example, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_example}" --out "${tmp}/out11"
assert_status 0
[[ -f "${tmp}/out11/candidate-receipt.json" ]] || case_fail "example config produced no receipt"
case_pass

# --- case 12: tampered npm integrity fails ---------------------------------------------
case_start "tampered npm integrity fails"
cfg_integrity="${tmp}/cfg-integrity.json"
write_config "${cfg_integrity}" "lab"
python3 - "${cfg_integrity}" <<'PY'
import base64
import json
import sys

path = sys.argv[1]
doc = json.load(open(path))
surface = doc["apptheory"]["candidate"]["surfaces"]["npm_cdk"]
altered = "sha512-" + base64.b64encode(bytes([0xFF]) * 64).decode()
assert altered != surface["integrity"]
surface["integrity"] = altered
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
out_integrity="${tmp}/out-integrity"
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_integrity}" --out "${out_integrity}"
assert_status 1
assert_stderr_contains "surface npm_cdk integrity mismatch"
[[ ! -f "${out_integrity}/theory-cloud-apptheory-cdk-9.9.9.tgz" ]] || case_fail "integrity-mismatched artifact was left in --out"
case_pass

# --- case 13: source_date_epoch mismatch fails -----------------------------------------
case_start "source_date_epoch mismatch fails"
cfg_epoch="${tmp}/cfg-epoch.json"
write_config "${cfg_epoch}" "lab"
encoded_epoch=$((fixture_epoch + 1))
python3 - "${cfg_epoch}" "${encoded_epoch}" <<'PY'
import json
import sys

path, epoch = sys.argv[1], int(sys.argv[2])
doc = json.load(open(path))
doc["apptheory"]["candidate"]["source_date_epoch"] = epoch
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_epoch}" --out "${tmp}/out-epoch"
assert_status 1
assert_stderr_contains "source_date_epoch mismatch (encoded '${encoded_epoch}' != commit committer timestamp '${fixture_epoch}')"
case_pass

# --- case 14: encoded artifact file mismatch fails -------------------------------------
# The build path inspects the artifact the build actually produced and checks its basename
# against the version-derived expected basename; --print-plan has no artifact yet, so it
# validates the encoded name directly. Both must refuse the mismatched name.
case_start "encoded artifact file mismatch fails"
cfg_file="${tmp}/cfg-file.json"
write_config "${cfg_file}" "lab"
python3 - "${cfg_file}" <<'PY'
import json
import sys

path = sys.argv[1]
doc = json.load(open(path))
doc["apptheory"]["candidate"]["surfaces"]["npm_cdk"]["file"] = "theory-cloud-apptheory-cdk-9.9.8.tgz"
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_file}" --out "${tmp}/out-file"
assert_status 1
assert_stderr_contains "theory-cloud-apptheory-cdk-9.9.8.tgz"
assert_stderr_contains "theory-cloud-apptheory-cdk-9.9.9.tgz"
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_file}" --print-plan
assert_status 1
assert_stderr_contains "theory-cloud-apptheory-cdk-9.9.8.tgz"
assert_stderr_contains "theory-cloud-apptheory-cdk-9.9.9.tgz"
case_pass

# --- case 15: a declared subset is built, and undeclared surfaces are never built -------
# The contract is a DECLARED SUBSET: only surfaces the config declares are built, verified,
# handed over and receipted. The undeclared surfaces must not be built at all (their build
# scripts must not run), so the fixture's dist/ keeps only the declared artifacts.
case_start "a declared subset is built and undeclared surfaces are never built"
cfg_subset="${tmp}/cfg-subset.json"
write_config "${cfg_subset}" "lab"
python3 - "${cfg_subset}" <<'PY'
import json
import sys

path = sys.argv[1]
doc = json.load(open(path))
surfaces = doc["apptheory"]["candidate"]["surfaces"]
# A TMS-class consumer: the Go runtime tree plus the npm CDK package.
for name in list(surfaces):
    if name not in ("go_runtime", "npm_cdk"):
        del surfaces[name]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
rm -rf "${fixture}/dist"
out_subset="${tmp}/out-subset"
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_subset}" --out "${out_subset}"
assert_status 0
for artifact in go_runtime.tar theory-cloud-apptheory-cdk-9.9.9.tgz; do
  [[ -f "${out_subset}/${artifact}" ]] || case_fail "missing declared artifact in --out: ${artifact}"
done
for artifact in \
  go_cdk.tar \
  theory-cloud-apptheory-9.9.9.tgz \
  apptheory-9.9.9-py3-none-any.whl \
  apptheory-9.9.9.tar.gz \
  apptheory_cdk-9.9.9-py3-none-any.whl; do
  [[ ! -f "${out_subset}/${artifact}" ]] || case_fail "undeclared artifact was handed over: ${artifact}"
done
for artifact in \
  go_cdk.tar \
  theory-cloud-apptheory-9.9.9.tgz \
  apptheory-9.9.9-py3-none-any.whl \
  apptheory-9.9.9.tar.gz \
  apptheory_cdk-9.9.9-py3-none-any.whl; do
  [[ ! -f "${fixture}/dist/${artifact}" ]] || case_fail "undeclared surface was built: ${artifact}"
done
python3 - "${out_subset}/candidate-receipt.json" <<'PY'
import json
import sys

receipt = json.load(open(sys.argv[1]))
assert set(receipt["surfaces"]) == {"go_runtime", "npm_cdk"}, receipt["surfaces"]
assert set(receipt["commands"]) == set(receipt["surfaces"]), receipt["commands"]
PY
last_line="$(printf '%s\n' "${builder_stdout}" | tail -n 1)"
[[ "${last_line}" == "candidate-build: PASS (lab ${fixture_commit}; 2 surfaces verified)" ]] \
  || case_fail "final PASS line mismatch: ${last_line}"
case_pass

# --- case 16: an empty declared surface set is refused ---------------------------------
case_start "an empty declared surface set is refused"
cfg_empty="${tmp}/cfg-empty.json"
write_config "${cfg_empty}" "lab"
python3 - "${cfg_empty}" <<'PY'
import json
import sys

path = sys.argv[1]
doc = json.load(open(path))
doc["apptheory"]["candidate"]["surfaces"] = {}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_empty}" --out "${tmp}/out-empty"
assert_status 1
assert_stderr_contains "no declared surface"
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_empty}" --print-plan
assert_status 1
assert_stderr_contains "no declared surface"
cfg_no_surfaces="${tmp}/cfg-no-surfaces.json"
write_config "${cfg_no_surfaces}" "lab"
python3 - "${cfg_no_surfaces}" <<'PY'
import json
import sys

path = sys.argv[1]
doc = json.load(open(path))
del doc["apptheory"]["candidate"]["surfaces"]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_no_surfaces}" --out "${tmp}/out-no-surfaces"
assert_status 1
assert_stderr_contains "no declared surface"
case_pass

# --- case 17: a declared npm surface without its integrity fails -----------------------
case_start "a declared npm surface without its integrity fails"
cfg_no_integrity="${tmp}/cfg-no-integrity.json"
write_config "${cfg_no_integrity}" "lab"
python3 - "${cfg_no_integrity}" <<'PY'
import json
import sys

path = sys.argv[1]
doc = json.load(open(path))
surfaces = doc["apptheory"]["candidate"]["surfaces"]
del surfaces["npm_ts_runtime"]["integrity"]
for name in list(surfaces):
    if name != "npm_ts_runtime":
        del surfaces[name]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_no_integrity}" --out "${tmp}/out-no-integrity"
assert_status 1
assert_stderr_contains "declared surface 'npm_ts_runtime' is missing its encoded integrity"
case_pass

# --- case 18: a declared surface the config cannot name fails --------------------------
case_start "a declared surface with a stray file name fails"
cfg_declared_file="${tmp}/cfg-declared-file.json"
write_config "${cfg_declared_file}" "lab"
python3 - "${cfg_declared_file}" <<'PY'
import json
import sys

path = sys.argv[1]
doc = json.load(open(path))
surfaces = doc["apptheory"]["candidate"]["surfaces"]
surfaces["py_runtime_wheel"]["file"] = "apptheory-9.9.8-py3-none-any.whl"
for name in list(surfaces):
    if name != "py_runtime_wheel":
        del surfaces[name]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_declared_file}" --out "${tmp}/out-declared-file"
assert_status 1
assert_stderr_contains "declared surface 'py_runtime_wheel' file mismatch"
assert_stderr_contains "apptheory-9.9.8-py3-none-any.whl"
case_pass

# --- case 19: an unknown surface key is refused ----------------------------------------
# A key that is not one of the seven must never be silently ignored: the config author
# would believe a surface is bound when nothing about it is built or verified.
case_start "an unknown surface key is refused"
cfg_unknown="${tmp}/cfg-unknown.json"
write_config "${cfg_unknown}" "lab"
python3 - "${cfg_unknown}" <<'PY'
import json
import sys

path = sys.argv[1]
doc = json.load(open(path))
surfaces = doc["apptheory"]["candidate"]["surfaces"]
surfaces["go_runtime_extra"] = {"sha256": "8" * 64}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_unknown}" --out "${tmp}/out-unknown"
assert_status 1
assert_stderr_contains "unknown surface key(s) in candidate.surfaces: go_runtime_extra"
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_unknown}" --print-plan
assert_status 1
assert_stderr_contains "unknown surface key(s) in candidate.surfaces: go_runtime_extra"
case_pass

# --- case 20: a per-surface commit is refused ------------------------------------------
# One encoded commit binds every surface, so a per-surface commit is invalid per the
# interface spec and must be refused rather than ignored.
case_start "a per-surface commit is refused"
cfg_surface_commit="${tmp}/cfg-surface-commit.json"
write_config "${cfg_surface_commit}" "lab"
python3 - "${cfg_surface_commit}" <<'PY'
import json
import sys

path = sys.argv[1]
doc = json.load(open(path))
surfaces = doc["apptheory"]["candidate"]["surfaces"]
surfaces["go_runtime"]["commit"] = "9" * 40
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_surface_commit}" --out "${tmp}/out-surface-commit"
assert_status 1
assert_stderr_contains "surface 'go_runtime' carries unsupported field(s): commit"
assert_stderr_contains "per-surface commit is invalid"
case_pass

# --- case 21: a misspelled surface field is refused ------------------------------------
case_start "a misspelled surface field is refused"
cfg_typo="${tmp}/cfg-typo.json"
write_config "${cfg_typo}" "lab"
python3 - "${cfg_typo}" <<'PY'
import json
import sys

path = sys.argv[1]
doc = json.load(open(path))
surface = doc["apptheory"]["candidate"]["surfaces"]["npm_cdk"]
surface["sha_256"] = surface.pop("sha256")
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_typo}" --out "${tmp}/out-typo"
assert_status 1
assert_stderr_contains "surface 'npm_cdk' carries unsupported field(s): sha_256"
case_pass

# --- case 22: an empty witnessed hash is refused by name before any build ---------------
# The named presence error must be the control that stops the run: if the check were
# removed, the surface would be built and only the later generic hash compare would catch
# it (the backstop). Assert the named error AND that the backstop did not speak, and that
# no build ran.
case_start "an empty witnessed hash is refused by name before any build"
cfg_empty_sha="${tmp}/cfg-empty-sha.json"
write_config "${cfg_empty_sha}" "lab"
python3 - "${cfg_empty_sha}" <<'PY'
import json
import sys

path = sys.argv[1]
doc = json.load(open(path))
surfaces = doc["apptheory"]["candidate"]["surfaces"]
surfaces["py_cdk_wheel"]["sha256"] = ""
for name in list(surfaces):
    if name != "py_cdk_wheel":
        del surfaces[name]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
dist_before_sha="$(snapshot_dir "${fixture}/dist")"
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_empty_sha}" --out "${tmp}/out-empty-sha"
assert_status 1
assert_stderr_contains "declared surface 'py_cdk_wheel' is missing a non-empty sha256"
[[ "${builder_stderr}" != *"hash mismatch"* ]] || case_fail "the generic hash backstop spoke instead of the named check"
[[ "${builder_stderr}" != *"Traceback"* ]] || case_fail "a python traceback replaced the named refusal"
dist_after_sha="$(snapshot_dir "${fixture}/dist")"
[[ "${dist_before_sha}" == "${dist_after_sha}" ]] || case_fail "a refusal before the build still ran a build"
case_pass

# --- case 23: a failing per-surface build surfaces its named build error ---------------
# The named build error must fire, not a later generic error: the artifact the failed build
# would have produced is absent, so without the guard the run would end in a missing-
# artifact or hashing error instead.
case_start "a failing per-surface build surfaces its named build error"
printf '#!/usr/bin/env bash\nset -euo pipefail\nexit 7\n' > "${fixture}/scripts/verify-cdk-python-build.sh"
chmod +x "${fixture}/scripts/verify-cdk-python-build.sh"
git -C "${fixture}" add -A
git -C "${fixture}" commit -q -m "fixture: make the python cdk build fail"
failing_commit="$(git -C "${fixture}" rev-parse HEAD)"
failing_tree="$(git -C "${fixture}" rev-parse "HEAD^{tree}")"
failing_epoch="$(git -C "${fixture}" show -s --format=%ct HEAD)"
cfg_build_fail="${tmp}/cfg-build-fail.json"
write_config "${cfg_build_fail}" "lab" "${failing_commit}" "${failing_tree}" "${failing_epoch}"
python3 - "${cfg_build_fail}" <<'PY'
import json
import sys

path = sys.argv[1]
doc = json.load(open(path))
surfaces = doc["apptheory"]["candidate"]["surfaces"]
for name in list(surfaces):
    if name != "py_cdk_wheel":
        del surfaces[name]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_build_fail}" --out "${tmp}/out-build-fail"
assert_status 1
assert_stderr_contains "surface py_cdk_wheel build failed (./scripts/verify-cdk-python-build.sh)"
[[ "${builder_stderr}" != *"artifact is missing"* ]] || case_fail "the missing-artifact error replaced the named build error"
[[ "${builder_stderr}" != *"Traceback"* ]] || case_fail "a python traceback replaced the named build error"
case_pass

# --- case 24: a build that produces no artifact surfaces its named artifact error ------
# A build that "succeeds" without producing the declared artifact must be named as such
# rather than ending in a hashing traceback.
case_start "a build that produces no artifact surfaces its named artifact error"
printf '#!/usr/bin/env bash\nset -euo pipefail\n# deliberately produces no artifact\nexit 0\n' \
  > "${fixture}/scripts/verify-cdk-python-build.sh"
chmod +x "${fixture}/scripts/verify-cdk-python-build.sh"
git -C "${fixture}" add -A
git -C "${fixture}" commit -q -m "fixture: python cdk build writes nothing"
silent_commit="$(git -C "${fixture}" rev-parse HEAD)"
silent_tree="$(git -C "${fixture}" rev-parse "HEAD^{tree}")"
silent_epoch="$(git -C "${fixture}" show -s --format=%ct HEAD)"
cfg_no_artifact="${tmp}/cfg-no-artifact.json"
write_config "${cfg_no_artifact}" "lab" "${silent_commit}" "${silent_tree}" "${silent_epoch}"
python3 - "${cfg_no_artifact}" <<'PY'
import json
import sys

path = sys.argv[1]
doc = json.load(open(path))
surfaces = doc["apptheory"]["candidate"]["surfaces"]
for name in list(surfaces):
    if name != "py_cdk_wheel":
        del surfaces[name]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
rm -f "${fixture}/dist/apptheory_cdk-9.9.9-py3-none-any.whl"
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_no_artifact}" --out "${tmp}/out-no-artifact"
assert_status 1
assert_stderr_contains "surface py_cdk_wheel artifact is missing:"
[[ "${builder_stderr}" != *"Traceback"* ]] || case_fail "a python traceback replaced the named artifact error"
[[ "${builder_stderr}" != *"hash mismatch"* ]] || case_fail "the generic hash backstop spoke instead of the named artifact check"
# Restore the fixture to its witnessed commit and its stand-in build scripts.
git -C "${fixture}" reset -q --hard "${fixture_commit}"
case_pass

# --- case 25: a committed .gitattributes export-ignore filter is refused ----------------
# The attack (ADV-APPT1150-F1): commit an `export-ignore` .gitattributes at the pinned
# commit. `git archive` then silently drops the filtered paths, and because the witnessed
# build runs the SAME archive command it filters identically -- so the recorded hash still
# matches and a hash-only builder would hand over a tree that is not the pinned commit's. The
# witness below is computed from that same filtered archive, so this case fails unless the
# pinned commit is refused. The refusal must be the named, tree-level ATTRIBUTE error (the
# whole class, fired before anything is archived) -- not the entry-list comparison and not the
# content compare, which stay as the backstop for attributes set outside the tree.
case_start "a committed .gitattributes export-ignore filter is refused"
printf 'cdk/ export-ignore\n' > "${fixture}/.gitattributes"
git -C "${fixture}" add -A
git -C "${fixture}" commit -q -m "fixture: commit an export-ignore .gitattributes"
filter_commit="$(git -C "${fixture}" rev-parse HEAD)"
filter_tree="$(git -C "${fixture}" rev-parse "HEAD^{tree}")"
filter_epoch="$(git -C "${fixture}" show -s --format=%ct HEAD)"
git -C "${fixture}" archive --format=tar --output="${tmp}/filtered.tar" "${filter_commit}" -- . ':(exclude)cdk-go'
filtered_sha="$(python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "${tmp}/filtered.tar")"
cfg_filter="${tmp}/cfg-filter.json"
write_config "${cfg_filter}" "lab" "${filter_commit}" "${filter_tree}" "${filter_epoch}"
python3 - "${cfg_filter}" "${filtered_sha}" <<'PY'
import json
import sys

path, filtered_sha = sys.argv[1], sys.argv[2]
doc = json.load(open(path))
surfaces = doc["apptheory"]["candidate"]["surfaces"]
for name in list(surfaces):
    if name != "go_runtime":
        del surfaces[name]
# The witnessed hash of the FILTERED archive: the hash alone cannot tell the difference.
surfaces["go_runtime"]["sha256"] = filtered_sha
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_filter}" --out "${tmp}/out-filter"
assert_status 1
assert_stderr_contains "archive-affecting .gitattributes attribute"
assert_stderr_contains ".gitattributes:1: pattern 'cdk/' sets the archive-affecting attribute 'export-ignore'"
[[ "${builder_stderr}" != *"archive entry list does not match"* ]] \
  || case_fail "the entry-list check spoke instead of the named attribute refusal"
[[ "${builder_stderr}" != *"archive content does not match"* ]] \
  || case_fail "the content compare spoke instead of the named attribute refusal"
[[ "${builder_stderr}" != *"hash mismatch"* ]] \
  || case_fail "the recorded hash matched the filtered archive, so only the attribute refusal can refuse this"
[[ ! -f "${tmp}/out-filter/go_runtime.tar" ]] || case_fail "a filtered archive was handed over"
# The refusal is a property of the pinned tree, so it must fire in --print-plan mode as well
# (the plan path reaches this check before it refuses or prints anything), and as the same named
# error: a check that only runs on the build path would leave the plan mode green.
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_filter}" --print-plan
assert_status 1
assert_stderr_contains "archive-affecting .gitattributes attribute"
[[ "${builder_stderr}" != *"archive entry list does not match"* ]] \
  || case_fail "the entry-list check spoke instead of the named attribute refusal in --print-plan"
# The same filter must also be refused for S2 when it covers the cdk-go subtree.
printf 'cdk-go/apptheorycdk/go.mod export-ignore\n' > "${fixture}/.gitattributes"
git -C "${fixture}" add -A
git -C "${fixture}" commit -q -m "fixture: export-ignore the nested module's go.mod"
filtered_commit2="$(git -C "${fixture}" rev-parse HEAD)"
filtered_tree2="$(git -C "${fixture}" rev-parse "HEAD^{tree}")"
filtered_epoch2="$(git -C "${fixture}" show -s --format=%ct HEAD)"
git -C "${fixture}" archive --format=tar --output="${tmp}/filtered-cdk.tar" "${filtered_commit2}" -- cdk-go/apptheorycdk
filtered_cdk_sha="$(python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "${tmp}/filtered-cdk.tar")"
cfg_filter_cdk="${tmp}/cfg-filter-cdk.json"
write_config "${cfg_filter_cdk}" "lab" "${filtered_commit2}" "${filtered_tree2}" "${filtered_epoch2}"
python3 - "${cfg_filter_cdk}" "${filtered_cdk_sha}" <<'PY'
import json
import sys

path, filtered_sha = sys.argv[1], sys.argv[2]
doc = json.load(open(path))
surfaces = doc["apptheory"]["candidate"]["surfaces"]
for name in list(surfaces):
    if name != "go_cdk":
        del surfaces[name]
surfaces["go_cdk"]["sha256"] = filtered_sha
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_filter_cdk}" --out "${tmp}/out-filter-cdk"
assert_status 1
assert_stderr_contains "archive-affecting .gitattributes attribute"
assert_stderr_contains ".gitattributes:1: pattern 'cdk-go/apptheorycdk/go.mod' sets the archive-affecting attribute 'export-ignore'"
git -C "${fixture}" reset -q --hard "${fixture_commit}"
case_pass

# --- case 26: a committed .gitattributes export-subst filter is refused ------------------
# The second attack of the same class (ADV-APPT1150-R1-1): `export-subst` rewrites file
# CONTENT ($Format:%H$ -> the substituted commit id) and leaves every entry name in place, so
# the entry list is unchanged and the recorded hash -- the hash of the substituted archive --
# still matches. The case first proves the attack is real on the fixture (archived bytes differ
# from the pinned blob, entry names do not), then requires the named tree-level refusal, not
# the content compare behind it.
case_start "a committed .gitattributes export-subst filter is refused"
printf '* export-subst\n' > "${fixture}/.gitattributes"
git -C "${fixture}" add -A
git -C "${fixture}" commit -q -m "fixture: commit an export-subst .gitattributes"
subst_commit="$(git -C "${fixture}" rev-parse HEAD)"
subst_tree="$(git -C "${fixture}" rev-parse "HEAD^{tree}")"
subst_epoch="$(git -C "${fixture}" show -s --format=%ct HEAD)"
git -C "${fixture}" archive --format=tar --output="${tmp}/subst.tar" "${subst_commit}" -- . ':(exclude)cdk-go'
subst_sha="$(python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "${tmp}/subst.tar")"
python3 - "${tmp}/subst.tar" "${fixture}" "${subst_commit}" <<'PY'
import subprocess
import sys
import tarfile

archive_path, repo, commit = sys.argv[1], sys.argv[2], sys.argv[3]
with tarfile.open(archive_path, "r:") as archive:
    names = sorted(
        member.name
        for member in archive.getmembers()
        if member.isfile() or member.issym() or member.islnk()
    )
    archived = archive.extractfile(archive.getmember("VERSION-TEMPLATE.txt")).read()
pinned = subprocess.run(
    ["git", "-C", repo, "cat-file", "blob", f"{commit}:VERSION-TEMPLATE.txt"],
    check=True,
    capture_output=True,
).stdout
assert archived != pinned, "export-subst did not rewrite the archived content"
assert archived.strip().endswith(commit.encode()), archived
listed = subprocess.run(
    ["git", "-C", repo, "ls-tree", "-r", "--name-only", commit, "--", "."],
    check=True,
    capture_output=True,
    text=True,
).stdout.split()
expected_names = sorted(
    name for name in listed if not (name == "cdk-go" or name.startswith("cdk-go/"))
)
assert names == expected_names, (names, expected_names)
PY
cfg_subst="${tmp}/cfg-subst.json"
write_config "${cfg_subst}" "lab" "${subst_commit}" "${subst_tree}" "${subst_epoch}"
python3 - "${cfg_subst}" "${subst_sha}" <<'PY'
import json
import sys

path, filtered_sha = sys.argv[1], sys.argv[2]
doc = json.load(open(path))
surfaces = doc["apptheory"]["candidate"]["surfaces"]
for name in list(surfaces):
    if name != "go_runtime":
        del surfaces[name]
# The witnessed hash of the SUBSTITUTED archive: neither the hash nor the entry list can tell
# the difference.
surfaces["go_runtime"]["sha256"] = filtered_sha
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_subst}" --out "${tmp}/out-subst"
assert_status 1
assert_stderr_contains "archive-affecting .gitattributes attribute"
assert_stderr_contains "sets the archive-affecting attribute 'export-subst'"
[[ "${builder_stderr}" != *"archive entry list does not match"* ]] \
  || case_fail "the entry-list check spoke instead of the named attribute refusal"
[[ "${builder_stderr}" != *"archive content does not match"* ]] \
  || case_fail "the content compare spoke instead of the named attribute refusal"
[[ "${builder_stderr}" != *"hash mismatch"* ]] \
  || case_fail "the recorded hash matched the substituted archive, so only the attribute refusal can refuse this"
[[ ! -f "${tmp}/out-subst/go_runtime.tar" ]] || case_fail "a substituted archive was handed over"
git -C "${fixture}" reset -q --hard "${fixture_commit}"
case_pass

# --- case 27: an out-of-tree export-ignore attribute is refused by the entry list --------
# `git archive` also honours $GIT_DIR/info/attributes, which is not part of the pinned tree, so
# the tree-level refusal cannot see it: the entry-list comparison must still refuse a path the
# filter dropped. This keeps the entry-list control load-bearing now that the tree case
# (case 25) is refused earlier by name.
case_start "an out-of-tree export-ignore attribute is refused by the entry list"
mkdir -p "${fixture}/.git/info"
printf 'cdk/ export-ignore\n' > "${fixture}/.git/info/attributes"
git -C "${fixture}" archive --format=tar --output="${tmp}/info-filtered.tar" "${fixture_commit}" -- . ':(exclude)cdk-go'
info_filtered_sha="$(python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "${tmp}/info-filtered.tar")"
cfg_info_filter="${tmp}/cfg-info-filter.json"
write_config "${cfg_info_filter}" "lab"
python3 - "${cfg_info_filter}" "${info_filtered_sha}" <<'PY'
import json
import sys

path, filtered_sha = sys.argv[1], sys.argv[2]
doc = json.load(open(path))
surfaces = doc["apptheory"]["candidate"]["surfaces"]
for name in list(surfaces):
    if name != "go_runtime":
        del surfaces[name]
surfaces["go_runtime"]["sha256"] = filtered_sha
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_info_filter}" --out "${tmp}/out-info-filter"
assert_status 1
assert_stderr_contains "surface go_runtime archive entry list does not match the pinned commit tree"
assert_stderr_contains "filtered out of the archive"
assert_stderr_contains "cdk/package.json"
[[ "${builder_stderr}" != *"archive-affecting"* ]] \
  || case_fail "the tree-level attribute refusal fired for an attribute outside the pinned tree"
[[ "${builder_stderr}" != *"archive content does not match"* ]] \
  || case_fail "the content compare spoke instead of the entry-list check"
rm -f "${fixture}/.git/info/attributes"
case_pass

# --- case 28: an out-of-tree export-subst attribute is refused by the content compare ----
# The same out-of-tree route with `export-subst`: the entry names are unchanged, so the
# entry-list comparison passes and ONLY the blob-by-blob content compare can refuse it. This is
# the case that fails if the content compare is removed, so it pins that control.
case_start "an out-of-tree export-subst attribute is refused by the archive content compare"
mkdir -p "${fixture}/.git/info"
printf '* export-subst\n' > "${fixture}/.git/info/attributes"
git -C "${fixture}" archive --format=tar --output="${tmp}/info-subst.tar" "${fixture_commit}" -- . ':(exclude)cdk-go'
info_subst_sha="$(python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "${tmp}/info-subst.tar")"
cfg_info_subst="${tmp}/cfg-info-subst.json"
write_config "${cfg_info_subst}" "lab"
python3 - "${cfg_info_subst}" "${info_subst_sha}" <<'PY'
import json
import sys

path, filtered_sha = sys.argv[1], sys.argv[2]
doc = json.load(open(path))
surfaces = doc["apptheory"]["candidate"]["surfaces"]
for name in list(surfaces):
    if name != "go_runtime":
        del surfaces[name]
surfaces["go_runtime"]["sha256"] = filtered_sha
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${fixture}" --config "${cfg_info_subst}" --out "${tmp}/out-info-subst"
assert_status 1
assert_stderr_contains "surface go_runtime archive content does not match the pinned commit tree"
assert_stderr_contains "VERSION-TEMPLATE.txt"
assert_stderr_contains "content differs from the pinned blob"
[[ "${builder_stderr}" != *"archive-affecting"* ]] \
  || case_fail "the tree-level attribute refusal fired for an attribute outside the pinned tree"
[[ "${builder_stderr}" != *"archive entry list does not match"* ]] \
  || case_fail "the entry-list check spoke, though export-subst leaves every entry name in place"
[[ "${builder_stderr}" != *"hash mismatch"* ]] \
  || case_fail "the recorded hash matched the substituted archive, so only the content compare can refuse this"
[[ ! -f "${tmp}/out-info-subst/go_runtime.tar" ]] || case_fail "a substituted archive was handed over"
rm -f "${fixture}/.git/info/attributes"
case_pass

# --- case 29: the repository's own tree trips no archive check ---------------------------
# The new controls must not refuse a real tree. The fixture cases prove it for the fixture; this
# case runs the real builder against THIS repository (S1 only -- the npm and python surfaces are
# the only ones that need the network), so the tree-level attribute refusal, the entry-list
# comparison and the blob-by-blob content compare all run over the repository's own tracked
# files. The candidate builder requires a clean working tree, so a dirty checkout fails this
# case with that reason rather than a misleading one.
case_start "the repository's own tree trips no archive check"
if [[ -n "$(git -C "${repo_root}" status --porcelain)" ]]; then
  case_fail "the checkout is dirty, so the builder cannot run against it (the candidate builder requires a clean working tree)"
fi
real_commit="$(git -C "${repo_root}" rev-parse HEAD)"
real_tree="$(git -C "${repo_root}" rev-parse "HEAD^{tree}")"
real_epoch="$(git -C "${repo_root}" show -s --format=%ct HEAD)"
git -C "${repo_root}" archive --format=tar --output="${tmp}/real-go_runtime.tar" "${real_commit}" -- . ':(exclude)cdk-go'
real_sha="$(python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "${tmp}/real-go_runtime.tar")"
cfg_real="${tmp}/cfg-real.json"
python3 - "${cfg_real}" "${real_commit}" "${real_tree}" "${real_epoch}" "${real_sha}" <<'PY'
import json
import sys

path, commit, tree, epoch, sha = sys.argv[1:6]
doc = {
    "stage": "lab",
    "expected_account_id": "123456789012",
    "apptheory": {
        "candidate": {
            "commit": commit,
            "tree": tree,
            "source_date_epoch": int(epoch),
            "surfaces": {"go_runtime": {"sha256": sha}},
        }
    },
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2)
PY
run_builder bash "${builder}" --repo "${repo_root}" --config "${cfg_real}" --out "${tmp}/out-real"
assert_status 0
[[ -f "${tmp}/out-real/go_runtime.tar" ]] || case_fail "the real-tree build handed over no go_runtime.tar"
last_line="$(printf '%s\n' "${builder_stdout}" | tail -n 1)"
[[ "${last_line}" == "candidate-build: PASS (lab ${real_commit}; 1 surfaces verified)" ]] \
  || case_fail "final PASS line mismatch: ${last_line}"
rm -f "${tmp}/real-go_runtime.tar" "${tmp}/out-real/go_runtime.tar"
case_pass

printf 'candidate-build: self-test PASS (%s cases)\n' "${cases_passed}"
