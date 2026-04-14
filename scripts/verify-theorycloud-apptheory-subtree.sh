#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

OUTPUT_DIR="${TMP_DIR}/out"
bash "${SCRIPT_DIR}/stage-theorycloud-apptheory-subtree.sh" --output "${OUTPUT_DIR}" >/dev/null

if [[ ! -f "${OUTPUT_DIR}/source-manifest.json" ]]; then
  echo "missing source manifest: ${OUTPUT_DIR}/source-manifest.json" >&2
  exit 1
fi

if [[ -d "${OUTPUT_DIR}/docs" ]]; then
  echo "unexpected nested docs/ directory in staged subtree" >&2
  exit 1
fi

python3 - "${REPO_ROOT}/docs" "${OUTPUT_DIR}" "$(git -C "${REPO_ROOT}" rev-parse HEAD)" <<'PY'
import datetime as dt
import fnmatch
import json
import pathlib
import sys

docs_root = pathlib.Path(sys.argv[1]).resolve()
output_dir = pathlib.Path(sys.argv[2]).resolve()
expected_revision = sys.argv[3]

sections = {
    "fixed_ingestible": [],
    "fixed_contract_only": [],
    "sanctioned_optional_ingestible": [],
    "out_of_scope": [],
}

current = None
for raw in (docs_root / "_contract.yaml").read_text(encoding="utf-8").splitlines():
    stripped = raw.strip()
    if stripped.endswith(":") and stripped[:-1] in sections:
        current = stripped[:-1]
        continue
    if current and stripped.startswith("- "):
        sections[current].append(stripped[2:].strip())
        continue
    if stripped and not raw.startswith("    "):
        current = None

def normalize(path: str) -> str:
    if not path.startswith("docs/"):
        raise SystemExit(f"unsupported contract path outside docs/: {path}")
    return path[len("docs/") :]

include_patterns = [normalize(value) for value in sections["fixed_ingestible"]]
include_patterns.extend(normalize(value) for value in sections["sanctioned_optional_ingestible"])
contract_only_patterns = [normalize(value) for value in sections["fixed_contract_only"]]
out_of_scope_patterns = [normalize(value) for value in sections["out_of_scope"]]
expected_exclusion_rules = out_of_scope_patterns + contract_only_patterns

all_doc_files = sorted(
    path.relative_to(docs_root).as_posix()
    for path in docs_root.rglob("*")
    if path.is_file()
)

def matches_any(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, pattern) for pattern in patterns)

expected_included = sorted(path for path in all_doc_files if matches_any(path, include_patterns))
expected_excluded = sorted(path for path in all_doc_files if path not in expected_included)

actual_staged_files = sorted(
    path.relative_to(output_dir).as_posix()
    for path in output_dir.rglob("*")
    if path.is_file() and path.name != "source-manifest.json"
)

missing = sorted(set(expected_included) - set(actual_staged_files))
unexpected = sorted(set(actual_staged_files) - set(expected_included))
if missing or unexpected:
    details = {"missing": missing, "unexpected": unexpected}
    raise SystemExit(f"staged subtree mismatch: {json.dumps(details, indent=2)}")

manifest = json.loads((output_dir / "source-manifest.json").read_text(encoding="utf-8"))

required_fields = {
    "module",
    "subtree",
    "source_repo",
    "source_revision",
    "generated_at",
    "included_file_count",
    "excluded_file_count",
    "exclusion_rules",
}
missing_fields = sorted(required_fields - set(manifest))
if missing_fields:
    raise SystemExit(f"manifest missing required fields: {missing_fields}")

if manifest["module"] != "theorycloud":
    raise SystemExit(f"unexpected module: {manifest['module']}")
if manifest["subtree"] != "apptheory":
    raise SystemExit(f"unexpected subtree: {manifest['subtree']}")
if manifest["source_repo"] != "theory-cloud/AppTheory":
    raise SystemExit(f"unexpected source_repo: {manifest['source_repo']}")
if manifest["source_revision"] != expected_revision:
    raise SystemExit(
        f"unexpected source_revision: {manifest['source_revision']} != {expected_revision}"
    )
if manifest["included_file_count"] != len(expected_included):
    raise SystemExit(
        f"unexpected included_file_count: {manifest['included_file_count']} != {len(expected_included)}"
    )
if manifest["excluded_file_count"] != len(expected_excluded):
    raise SystemExit(
        f"unexpected excluded_file_count: {manifest['excluded_file_count']} != {len(expected_excluded)}"
    )
if manifest["exclusion_rules"] != expected_exclusion_rules:
    raise SystemExit(
        "unexpected exclusion_rules: "
        + json.dumps({"actual": manifest["exclusion_rules"], "expected": expected_exclusion_rules}, indent=2)
    )

try:
    dt.datetime.fromisoformat(manifest["generated_at"].replace("Z", "+00:00"))
except ValueError as exc:
    raise SystemExit(f"generated_at is not RFC3339-like: {manifest['generated_at']} ({exc})") from exc

print(
    json.dumps(
        {
            "included": len(expected_included),
            "excluded": len(expected_excluded),
            "manifest": "ok",
        }
    )
)
PY

echo "verify-theorycloud-apptheory-subtree: PASS"
