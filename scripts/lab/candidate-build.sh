#!/usr/bin/env bash
# Purpose: lab candidate builder -- build and verify the declared AppTheory surfaces from one pinned commit.
#
# This is the single AppTheory-provided entry point specified by
# docs/development/planning/apptheory/mcp-auth-facade/CANDIDATE_BUILD_INTERFACE.md
# ("build AppTheory at a pinned commit" lab mode). Every build input comes from the
# encoded stage config (`apptheory.candidate`; `deployment.apptheory.candidate` is also
# accepted because the Autheory `app-theory/stages/*.json` files are shaped
# `{"schema":1,"deployment":{...}}`). No build input is ever taken from an operator
# environment variable -- SOURCE_DATE_EPOCH is derived from the pinned commit's committer
# timestamp, which makes the per-surface artifact hashes reproducible.
#
# The config declares a SURFACE SUBSET, one entry per key in the config's `surfaces` map:
#   go_runtime, go_cdk, npm_cdk, npm_ts_runtime, py_runtime_wheel, py_runtime_sdist, py_cdk_wheel
# At least one surface must be declared. Only declared surfaces are built, verified,
# handed over and receipted; an undeclared surface is never built, so a consumer that uses
# two surfaces records two and gets two. Every declared surface is bound to the one pinned
# commit exactly as a complete set would be, and a declared surface whose encoded witness
# is incomplete fails closed by name. A surface key outside the seven, and any field on a
# declared surface that is not an input (`file`, `sha256`, `integrity`) or a `_`-prefixed
# annotation, are refused rather than silently ignored -- a per-surface `commit` in
# particular is invalid, because the one encoded `commit` binds every surface.
# One declared Python runtime surface runs the repository's single python build, which
# produces both the wheel and the sdist; only the declared artifacts are verified, handed
# over and receipted.
#
# Surface -> command (the builder invokes the repository's own deterministic build entry
# points rather than re-implementing any build):
#   go_runtime        git -C <repo> archive --format=tar --output=<scratch>/go_runtime.tar <commit> -- . ':(exclude)cdk-go'
#   go_cdk            git -C <repo> archive --format=tar --output=<scratch>/go_cdk.tar <commit> -- cdk-go/apptheorycdk
#   npm_cdk           ./scripts/verify-cdk-ts-pack.sh
#   npm_ts_runtime    ./scripts/verify-ts-pack.sh
#   py_runtime_wheel  ./scripts/verify-python-build.sh   (one run produces wheel + sdist)
#   py_runtime_sdist  ./scripts/verify-python-build.sh
#   py_cdk_wheel      ./scripts/verify-cdk-python-build.sh
#
# The builder is incapable of targeting live for two independent reasons: the `stage`
# allowlist is exactly `lab`, and a config without an encoded `candidate` block is refused.
#
# Artifacts: the repo's own standard build outputs are written to <repo>/dist/ (exactly as
# `make build` does). The builder copies each *verified* artifact plus
# `<out>/candidate-receipt.json` into --out; nothing is copied before its hash is verified,
# and a hash mismatch deletes the artifact from --out and fails closed. Scratch work uses a
# `mktemp -d` tree removed by an EXIT trap. The receipt contains no wall-clock timestamps
# and no absolute paths -- its `commands` strings use <repo>/<scratch>/<commit> placeholders
# so the receipt is reproducible.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
default_repo="$(cd "${script_dir}/../.." && pwd)"
builder_path="scripts/lab/candidate-build.sh"

stage_allowlist="lab"
surface_names=(go_runtime go_cdk npm_cdk npm_ts_runtime py_runtime_wheel py_runtime_sdist py_cdk_wheel)
npm_surfaces=(npm_cdk npm_ts_runtime)

fail() {
  printf 'candidate-build: FAIL (%s)\n' "$1" >&2
  exit 1
}

usage_fail() {
  printf 'candidate-build: FAIL (%s)\n' "$1" >&2
  exit 2
}

usage() {
  cat <<EOF
Usage: candidate-build.sh --config <stage-config.json> --out <dir> [--repo <apptheory-root>] [--account-id <id>] [--print-plan]

  --config <path>     encoded stage config carrying the apptheory.candidate block (required)
  --out <dir>         directory that receives the verified artifacts and candidate-receipt.json
  --repo <path>       AppTheory repository root (default: ${default_repo})
  --account-id <id>   operator-supplied account id; must equal the encoded expected_account_id
  --print-plan        validate everything, print the plan; build nothing and write no receipt
  --help              show this usage

The only allowed candidate stage is: ${stage_allowlist}
The config declares the surface subset that is built and verified, at least one of:
  ${surface_names[*]}
EOF
}

repo=""
out=""
config=""
account_id=""
have_account_id=0
print_plan=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      [[ $# -ge 2 ]] || usage_fail "--config requires a value"
      config="$2"
      shift 2
      ;;
    --out)
      [[ $# -ge 2 ]] || usage_fail "--out requires a value"
      out="$2"
      shift 2
      ;;
    --repo)
      [[ $# -ge 2 ]] || usage_fail "--repo requires a value"
      repo="$2"
      shift 2
      ;;
    --account-id)
      [[ $# -ge 2 ]] || usage_fail "--account-id requires a value"
      account_id="$2"
      have_account_id=1
      shift 2
      ;;
    --print-plan)
      print_plan=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      usage_fail "unknown flag: $1"
      ;;
  esac
done

[[ -n "${config}" ]] || { usage >&2; usage_fail "--config is required"; }
if (( print_plan == 0 )) && [[ -z "${out}" ]]; then
  usage >&2
  usage_fail "--out is required for a real build"
fi
[[ -n "${repo}" ]] || repo="${default_repo}"

scratch="$(mktemp -d)"
trap 'rm -rf "${scratch}"' EXIT

# 1. No environment input. The encoded config is the only build input; any
#    APPTHEORY_CANDIDATE_* variable is refused by name.
env_candidate_vars="$(env | sed -n 's/^\(APPTHEORY_CANDIDATE_[A-Za-z0-9_]*\)=.*/\1/p' | sort -u | tr '\n' ' ')"
env_candidate_vars="${env_candidate_vars% }"
if [[ -n "${env_candidate_vars}" ]]; then
  fail "environment input is not allowed (set: ${env_candidate_vars}); encoded stage config is the only build input"
fi

# Read the config with python3 and hand bash a key<TAB>value stream.
if [[ ! -f "${config}" ]]; then
  fail "config not found: ${config}"
fi

cfg_lines="${scratch}/config.tsv"
if ! python3 - "${config}" > "${cfg_lines}" 2> "${scratch}/config.err" <<'PY'
import json
import sys

path = sys.argv[1]

try:
    with open(path, "r", encoding="utf-8") as handle:
        doc = json.load(handle)
except OSError as exc:
    raise SystemExit(f"cannot read config: {exc}")
except json.JSONDecodeError as exc:
    raise SystemExit(f"invalid JSON: {exc}")


def as_dict(value):
    return value if isinstance(value, dict) else None


def clean(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(int(value))
    return str(value).replace("\t", " ").replace("\n", " ").replace("\r", " ")


def emit(key, value):
    text = clean(value)
    if text is None or text == "":
        return
    sys.stdout.write(f"{key}\t{text}\n")


if not isinstance(doc, dict):
    raise SystemExit("config root must be a JSON object")

deployment = as_dict(doc.get("deployment"))


def candidate_of(container, label):
    if container is None or "candidate" not in container:
        return None, False
    value = container.get("candidate")
    if not isinstance(value, dict):
        raise SystemExit(f"{label}.candidate must be a JSON object")
    return value, True


top_candidate, top_present = candidate_of(as_dict(doc.get("apptheory")), "apptheory")
dep_candidate, dep_present = candidate_of(
    as_dict(deployment.get("apptheory")) if deployment is not None else None,
    "deployment.apptheory",
)

candidate = None
if top_present and dep_present:
    top_json = json.dumps(top_candidate, sort_keys=True, separators=(",", ":"))
    dep_json = json.dumps(dep_candidate, sort_keys=True, separators=(",", ":"))
    if top_json != dep_json:
        raise SystemExit(
            "ambiguous candidate block: top-level apptheory.candidate and "
            "deployment.apptheory.candidate are both present but differ"
        )
    candidate = top_candidate
elif top_present:
    candidate = top_candidate
elif dep_present:
    candidate = dep_candidate

stage = doc.get("stage")
if stage is None and deployment is not None:
    stage = deployment.get("stage")

account = doc.get("expected_account_id")
if account is None and deployment is not None:
    account = deployment.get("expected_account_id")

emit("stage", stage)
emit("expected_account_id", account)

SURFACE_ORDER = (
    "go_runtime",
    "go_cdk",
    "npm_cdk",
    "npm_ts_runtime",
    "py_runtime_wheel",
    "py_runtime_sdist",
    "py_cdk_wheel",
)

# The only per-surface inputs; anything else must be a '_'-prefixed annotation.
SURFACE_FIELDS = ("file", "sha256", "integrity")

if candidate is None:
    sys.stdout.write("candidate_present\t0\n")
else:
    sys.stdout.write("candidate_present\t1\n")
    emit("commit", candidate.get("commit"))
    emit("tree", candidate.get("tree"))
    emit("source_date_epoch", candidate.get("source_date_epoch"))

    # The declared surface subset: only these surfaces are built, verified, handed
    # over and receipted. A surface key outside the seven, and any non-annotation
    # field on a declared surface, is refused rather than silently ignored.
    surfaces = as_dict(candidate.get("surfaces"))
    declared = []
    if surfaces is not None:
        unknown_surfaces = sorted(key for key in surfaces if key not in SURFACE_ORDER)
        if unknown_surfaces:
            raise SystemExit(
                "unknown surface key(s) in candidate.surfaces: "
                + ", ".join(unknown_surfaces)
                + " (a declared surface must be one of "
                + ", ".join(SURFACE_ORDER)
                + ")"
            )
        for name in SURFACE_ORDER:
            if name not in surfaces:
                continue
            entry = as_dict(surfaces.get(name))
            if entry is not None:
                unsupported = sorted(
                    key
                    for key in entry
                    if not key.startswith("_") and key not in SURFACE_FIELDS
                )
                if unsupported:
                    raise SystemExit(
                        "surface '" + name + "' carries unsupported field(s): "
                        + ", ".join(unsupported)
                        + " (one commit binds every surface, so a per-surface commit is invalid; "
                        + "allowed fields are "
                        + ", ".join(SURFACE_FIELDS)
                        + ", plus '_'-prefixed annotations)"
                    )
            declared.append(name)
            sys.stdout.write(f"surface_{name}_present\t1\n")
            if entry is None:
                continue
            for field in SURFACE_FIELDS:
                value = entry.get(field)
                if isinstance(value, str) and value != "":
                    sys.stdout.write(f"surface_{name}_{field}\t{value}\n")
    sys.stdout.write("declared_surfaces\t" + " ".join(declared) + "\n")
PY
then
  fail "invalid config ${config}: $(head -n 1 "${scratch}/config.err")"
fi

declare -A CFG=()
while IFS=$'\t' read -r cfg_key cfg_value; do
  [[ -z "${cfg_key}" ]] && continue
  CFG["${cfg_key}"]="${cfg_value}"
done < "${cfg_lines}"

# 2. Stage allowlist -- exactly `lab`.
stage="${CFG[stage]-}"
if [[ "${stage}" != "${stage_allowlist}" ]]; then
  fail "stage '${stage}' is not an allowed candidate stage (${stage_allowlist} is the only allowed candidate stage; a live config carries no candidate block)"
fi

# 3. The candidate block must be present.
if [[ "${CFG[candidate_present]-}" != "1" ]]; then
  fail "no encoded candidate block in ${config} (this builder never builds a stage without an encoded candidate block)"
fi

# 4. The declared surface subset -- at least one surface, in canonical order.
declared_surfaces=()
if [[ -n "${CFG[declared_surfaces]-}" ]]; then
  read -r -a declared_surfaces <<< "${CFG[declared_surfaces]}"
fi
if (( ${#declared_surfaces[@]} == 0 )); then
  fail "no declared surface in ${config} (declare at least one of ${surface_names[*]} in the candidate surfaces map; a config that declares nothing builds nothing)"
fi

# 5. Every declared surface carries its encoded witness: a non-empty sha256, plus
#    file and integrity for the two npm surfaces. An undeclared surface is not
#    checked because it is never built, verified or handed over.
for name in "${declared_surfaces[@]}"; do
  if [[ "${CFG[surface_${name}_present]-}" != "1" || -z "${CFG[surface_${name}_sha256]-}" ]]; then
    fail "declared surface '${name}' is missing a non-empty sha256 (every declared surface must carry its witnessed hash)"
  fi
done
for name in "${declared_surfaces[@]}"; do
  case " ${npm_surfaces[*]} " in
    *" ${name} "*) ;;
    *) continue ;;
  esac
  [[ -n "${CFG[surface_${name}_file]-}" ]] || fail "declared surface '${name}' is missing its encoded file"
  [[ -n "${CFG[surface_${name}_integrity]-}" ]] || fail "declared surface '${name}' is missing its encoded integrity"
done

# 6. commit and tree are 40 lowercase hex characters.
commit="${CFG[commit]-}"
if ! [[ "${commit}" =~ ^[0-9a-f]{40}$ ]]; then
  fail "commit '${commit}' is not 40 lowercase hex characters"
fi
tree="${CFG[tree]-}"
if ! [[ "${tree}" =~ ^[0-9a-f]{40}$ ]]; then
  fail "tree '${tree}' is not 40 lowercase hex characters"
fi

# 7. expected_account_id, checked against --account-id when supplied.
expected_account="${CFG[expected_account_id]-}"
if [[ -z "${expected_account}" ]]; then
  fail "expected_account_id is missing from ${config}"
fi
if (( have_account_id == 1 )) && [[ "${account_id}" != "${expected_account}" ]]; then
  fail "account id mismatch (--account-id '${account_id}' != encoded expected_account_id '${expected_account}')"
fi

# 8. Repository binding.
if [[ ! -d "${repo}" ]]; then
  fail "repo not found: ${repo}"
fi
repo="$(cd "${repo}" && pwd)"
if ! git -C "${repo}" rev-parse --git-dir >/dev/null 2>&1; then
  fail "${repo} is not a git repository"
fi

status_out="$(git -C "${repo}" status --porcelain)"
if [[ -n "${status_out}" ]]; then
  first_path="$(printf '%s\n' "${status_out}" | head -n 1 | cut -c4-)"
  fail "working tree is dirty (first offending path: ${first_path})"
fi

if ! head_sha="$(git -C "${repo}" rev-parse HEAD 2>/dev/null)"; then
  fail "could not resolve HEAD in ${repo}"
fi
if [[ "${head_sha}" != "${commit}" ]]; then
  fail "HEAD '${head_sha}' does not equal encoded commit '${commit}'"
fi

if ! real_tree="$(git -C "${repo}" rev-parse "${commit}^{tree}" 2>/dev/null)"; then
  fail "encoded commit '${commit}' is not a commit object in ${repo}"
fi
if [[ "${real_tree}" != "${tree}" ]]; then
  fail "encoded tree '${tree}' does not equal the commit tree '${real_tree}'"
fi

if [[ -z "$(git -C "${repo}" for-each-ref --contains "${commit}" --format='%(refname)')" ]]; then
  fail "commit '${commit}' is not reachable from any retained ref in ${repo}"
fi

# 9. source_date_epoch derives from the commit's committer timestamp.
committer_epoch="$(git -C "${repo}" show -s --format=%ct "${commit}")"
if [[ -n "${CFG[source_date_epoch]-}" ]] && [[ "${CFG[source_date_epoch]}" != "${committer_epoch}" ]]; then
  fail "source_date_epoch mismatch (encoded '${CFG[source_date_epoch]}' != commit committer timestamp '${committer_epoch}')"
fi
effective_epoch="${committer_epoch}"
export SOURCE_DATE_EPOCH="${effective_epoch}"

if ! version="$(cd "${repo}" && ./scripts/read-version.sh 2>/dev/null)"; then
  fail "could not read the version via ./scripts/read-version.sh in ${repo}"
fi
py_version="${version}"
if [[ "${py_version}" == *"-rc."* ]]; then
  py_version="${py_version/-rc./rc}"
elif [[ "${py_version}" == *"-rc" ]]; then
  py_version="${py_version/-rc/rc0}"
fi

declare -A artifact_basename=(
  [go_runtime]="go_runtime.tar"
  [go_cdk]="go_cdk.tar"
  [npm_cdk]="theory-cloud-apptheory-cdk-${version}.tgz"
  [npm_ts_runtime]="theory-cloud-apptheory-${version}.tgz"
  [py_runtime_wheel]="apptheory-${py_version}-py3-none-any.whl"
  [py_runtime_sdist]="apptheory-${py_version}.tar.gz"
  [py_cdk_wheel]="apptheory_cdk-${py_version}-py3-none-any.whl"
)

declare -A surface_command=(
  [go_runtime]="git -C <repo> archive --format=tar --output=<scratch>/go_runtime.tar <commit> -- . ':(exclude)cdk-go'"
  [go_cdk]="git -C <repo> archive --format=tar --output=<scratch>/go_cdk.tar <commit> -- cdk-go/apptheorycdk"
  [npm_cdk]="./scripts/verify-cdk-ts-pack.sh"
  [npm_ts_runtime]="./scripts/verify-ts-pack.sh"
  [py_runtime_wheel]="./scripts/verify-python-build.sh"
  [py_runtime_sdist]="./scripts/verify-python-build.sh"
  [py_cdk_wheel]="./scripts/verify-cdk-python-build.sh"
)

# The encoded `file`, when present, must equal the plain version-derived artifact basename. It
# names the artifact the build must produce and can therefore never carry a path component, so
# the artifact is always read from a direct child of the repository's dist/ tree. This runs
# before any build, in both modes, for the declared surfaces.
for name in "${declared_surfaces[@]}"; do
  encoded_file="${CFG[surface_${name}_file]-}"
  if [[ -n "${encoded_file}" ]] && [[ "${encoded_file}" != "${artifact_basename[${name}]}" ]]; then
    fail "declared surface '${name}' file mismatch (encoded '${encoded_file}' != expected artifact basename '${artifact_basename[${name}]}')"
  fi
done

if (( print_plan == 1 )); then
  printf 'candidate-build: PLAN (nothing built, no receipt written)\n'
  printf '  config: %s\n' "${config}"
  printf '  stage: %s\n' "${stage}"
  printf '  commit: %s\n' "${commit}"
  printf '  tree: %s\n' "${tree}"
  printf '  source_date_epoch: %s\n' "${effective_epoch}"
  printf '  expected_account_id: %s\n' "${expected_account}"
  for name in "${declared_surfaces[@]}"; do
    printf '  %-18s %s\n' "${name}" "${surface_command[${name}]}"
    printf '  %-18s -> %s sha256=%s\n' "" "${artifact_basename[${name}]}" "${CFG[surface_${name}_sha256]-}"
  done
  printf 'candidate-build: PLAN OK (%s %s; %s declared surfaces would be verified)\n' "${stage}" "${commit}" "${#declared_surfaces[@]}"
  exit 0
fi

# Real build: --out is the destination for the verified artifacts and the receipt.
mkdir -p "${out}" || fail "cannot create --out directory: ${out}"
out="$(cd "${out}" && pwd)"

sha256_of() {
  python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1"
}

integrity_of() {
  python3 -c 'import base64, hashlib, sys; print("sha512-" + base64.b64encode(hashlib.sha512(open(sys.argv[1], "rb").read()).digest()).decode())' "$1"
}

# Locate the artifact for a package surface. The encoded `file` names the artifact the build
# must produce; verify_and_copy then checks the produced basename against the version-derived
# expected basename, so a mismatched encoded name fails closed at build time. When a surface
# carries no encoded `file` (allowed for the Python surfaces), the version-derived name is used.
surface_artifact_path() {
  local name="$1"
  local encoded="${CFG[surface_${name}_file]-}"
  if [[ -n "${encoded}" ]]; then
    printf '%s' "${repo}/dist/${encoded}"
  else
    printf '%s' "${repo}/dist/${artifact_basename[${name}]}"
  fi
}

declare -A surface_artifact=()
declare -A surface_sha=()
declare -A surface_integrity=()

verify_and_copy() {
  local name="$1"
  local artifact="$2"
  local expected_sha="${CFG[surface_${name}_sha256]-}"
  local expected_integrity="${CFG[surface_${name}_integrity]-}"
  # The encoded `file` was already required to equal this version-derived basename before any
  # build ran, so the artifact path is never steered by config and this is the recorded name.
  local basename_tmp="${artifact_basename[${name}]}"

  if [[ ! -f "${artifact}" ]]; then
    fail "surface ${name} artifact is missing: ${artifact}"
  fi

  local observed_sha
  observed_sha="$(sha256_of "${artifact}")"
  if [[ "${observed_sha}" != "${expected_sha}" ]]; then
    printf 'candidate-build: FAIL (surface %s hash mismatch)\n' "${name}" >&2
    printf '  encoded:  %s\n' "${expected_sha}" >&2
    printf '  observed: %s\n' "${observed_sha}" >&2
    printf '  artifact: %s\n' "${artifact}" >&2
    rm -f "${out}/${basename_tmp}"
    exit 1
  fi

  if [[ -n "${expected_integrity}" ]]; then
    local observed_integrity
    observed_integrity="$(integrity_of "${artifact}")"
    if [[ "${observed_integrity}" != "${expected_integrity}" ]]; then
      printf 'candidate-build: FAIL (surface %s integrity mismatch)\n' "${name}" >&2
      printf '  encoded:  %s\n' "${expected_integrity}" >&2
      printf '  observed: %s\n' "${observed_integrity}" >&2
      printf '  artifact: %s\n' "${artifact}" >&2
      rm -f "${out}/${basename_tmp}"
      exit 1
    fi
  fi

  cp "${artifact}" "${out}/${basename_tmp}"
  surface_artifact["${name}"]="${basename_tmp}"
  surface_sha["${name}"]="${observed_sha}"
  surface_integrity["${name}"]="${expected_integrity}"
}

printf 'candidate-build: building %s declared surfaces from %s (SOURCE_DATE_EPOCH=%s)\n' "${#declared_surfaces[@]}" "${commit}" "${effective_epoch}"

# S1 -- go_runtime
if [[ " ${declared_surfaces[*]} " == *" go_runtime "* ]]; then
  printf 'candidate-build: surface go_runtime\n'
  git -C "${repo}" archive --format=tar --output="${scratch}/go_runtime.tar" "${commit}" -- . ':(exclude)cdk-go' \
    || fail "surface go_runtime build failed (git archive)"
  verify_and_copy go_runtime "${scratch}/go_runtime.tar"
fi

# S2 -- go_cdk
if [[ " ${declared_surfaces[*]} " == *" go_cdk "* ]]; then
  printf 'candidate-build: surface go_cdk\n'
  git -C "${repo}" archive --format=tar --output="${scratch}/go_cdk.tar" "${commit}" -- cdk-go/apptheorycdk \
    || fail "surface go_cdk build failed (git archive)"
  verify_and_copy go_cdk "${scratch}/go_cdk.tar"
fi

# S3 -- npm_cdk
if [[ " ${declared_surfaces[*]} " == *" npm_cdk "* ]]; then
  printf 'candidate-build: surface npm_cdk\n'
  ( cd "${repo}" && ./scripts/verify-cdk-ts-pack.sh ) || fail "surface npm_cdk build failed (./scripts/verify-cdk-ts-pack.sh)"
  verify_and_copy npm_cdk "$(surface_artifact_path npm_cdk)"
fi

# S4 -- npm_ts_runtime
if [[ " ${declared_surfaces[*]} " == *" npm_ts_runtime "* ]]; then
  printf 'candidate-build: surface npm_ts_runtime\n'
  ( cd "${repo}" && ./scripts/verify-ts-pack.sh ) || fail "surface npm_ts_runtime build failed (./scripts/verify-ts-pack.sh)"
  verify_and_copy npm_ts_runtime "$(surface_artifact_path npm_ts_runtime)"
fi

# S5 -- python runtime (a single build produces both the wheel and the sdist; only the
# declared artifacts are verified, handed over and receipted).
declared_python_runtime=()
for name in "${declared_surfaces[@]}"; do
  case "${name}" in
    py_runtime_wheel|py_runtime_sdist) declared_python_runtime+=("${name}") ;;
  esac
done
if (( ${#declared_python_runtime[@]} > 0 )); then
  printf 'candidate-build: surface %s\n' "${declared_python_runtime[*]}"
  ( cd "${repo}" && ./scripts/verify-python-build.sh ) || fail "surface ${declared_python_runtime[0]} build failed (./scripts/verify-python-build.sh)"
  for name in "${declared_python_runtime[@]}"; do
    verify_and_copy "${name}" "$(surface_artifact_path "${name}")"
  done
fi

# S6 -- python CDK
if [[ " ${declared_surfaces[*]} " == *" py_cdk_wheel "* ]]; then
  printf 'candidate-build: surface py_cdk_wheel\n'
  ( cd "${repo}" && ./scripts/verify-cdk-python-build.sh ) || fail "surface py_cdk_wheel build failed (./scripts/verify-cdk-python-build.sh)"
  verify_and_copy py_cdk_wheel "$(surface_artifact_path py_cdk_wheel)"
fi

# Receipt (pretty JSON, keys sorted, no wall-clock timestamps).
receipt_lines="${scratch}/receipt.tsv"
: > "${receipt_lines}"
for pair in "stage:${stage}" "commit:${commit}" "tree:${tree}" "source_date_epoch:${effective_epoch}"; do
  printf 'meta\t%s\t%s\n' "${pair%%:*}" "${pair#*:}" >> "${receipt_lines}"
done
for name in "${declared_surfaces[@]}"; do
  printf 'surface\t%s\t%s\t%s\t%s\t%s\n' \
    "${name}" \
    "${surface_artifact[${name}]}" \
    "${surface_sha[${name}]}" \
    "${surface_integrity[${name}]-}" \
    "${surface_command[${name}]}" >> "${receipt_lines}"
done

receipt_path="${out}/candidate-receipt.json"
python3 - "${receipt_lines}" "${receipt_path}" "${builder_path}" <<'PY'
import json
import sys

lines_path, out_path, builder = sys.argv[1], sys.argv[2], sys.argv[3]

meta = {}
surfaces = {}
commands = {}

with open(lines_path, "r", encoding="utf-8") as handle:
    for line in handle:
        parts = line.rstrip("\n").split("\t")
        if not parts or parts[0] == "":
            continue
        if parts[0] == "meta":
            meta[parts[1]] = parts[2]
        elif parts[0] == "surface":
            name, artifact, sha256, integrity, command = parts[1:6]
            entry = {"artifact": artifact, "sha256": sha256}
            if integrity:
                entry["integrity"] = integrity
            surfaces[name] = entry
            commands.setdefault(name, []).append(command)

receipt = {
    "schema": "apptheory.candidate-receipt/v1",
    "stage": meta["stage"],
    "commit": meta["commit"],
    "tree": meta["tree"],
    "source_date_epoch": int(meta["source_date_epoch"]),
    "builder": builder,
    "surfaces": surfaces,
    "commands": commands,
}

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(receipt, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY

printf 'candidate-build: receipt\n'
printf '  stage: %s\n' "${stage}"
printf '  commit: %s\n' "${commit}"
printf '  tree: %s\n' "${tree}"
printf '  source_date_epoch: %s\n' "${effective_epoch}"
for name in "${declared_surfaces[@]}"; do
  printf '  %-18s %s  %s\n' "${name}" "${surface_sha[${name}]}" "${surface_artifact[${name}]}"
done
printf '  receipt: %s\n' "${receipt_path}"
printf 'candidate-build: PASS (%s %s; %s surfaces verified)\n' "${stage}" "${commit}" "${#declared_surfaces[@]}"
