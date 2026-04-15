#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'EOF_USAGE'
Usage:
  bash scripts/stage-theorycloud-apptheory-subtree.sh [--output DIR] [--docs-root DIR]

Environment overrides:
  THEORYCLOUD_APPTHEORY_SUBTREE_OUTPUT_DIR   Output directory. Default: <repo>/dist/theorycloud-apptheory-subtree
  THEORYCLOUD_APPTHEORY_DOCS_ROOT            Docs root. Default: <repo>/docs
  THEORYCLOUD_APPTHEORY_SOURCE_REPO          Source repository name. Default: theory-cloud/AppTheory
  THEORYCLOUD_APPTHEORY_SOURCE_REVISION      Source revision. Default: current git HEAD
EOF_USAGE
}

OUTPUT_DIR="${THEORYCLOUD_APPTHEORY_SUBTREE_OUTPUT_DIR:-${REPO_ROOT}/dist/theorycloud-apptheory-subtree}"
DOCS_ROOT="${THEORYCLOUD_APPTHEORY_DOCS_ROOT:-${REPO_ROOT}/docs}"
SOURCE_REPO="${THEORYCLOUD_APPTHEORY_SOURCE_REPO:-theory-cloud/AppTheory}"
SOURCE_REVISION="${THEORYCLOUD_APPTHEORY_SOURCE_REVISION:-$(git -C "${REPO_ROOT}" rev-parse HEAD)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      if [[ $# -lt 2 ]]; then
        echo "missing value for --output" >&2
        exit 1
      fi
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --docs-root)
      if [[ $# -lt 2 ]]; then
        echo "missing value for --docs-root" >&2
        exit 1
      fi
      DOCS_ROOT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -d "${DOCS_ROOT}" ]]; then
  echo "missing docs root: ${DOCS_ROOT}" >&2
  exit 1
fi

if [[ ! -f "${DOCS_ROOT}/_contract.yaml" ]]; then
  echo "missing docs contract: ${DOCS_ROOT}/_contract.yaml" >&2
  exit 1
fi

rm -rf "${OUTPUT_DIR}"
mkdir -p "${OUTPUT_DIR}"

python3 - "${DOCS_ROOT}" "${OUTPUT_DIR}" "${SOURCE_REPO}" "${SOURCE_REVISION}" <<'PY'
import datetime as dt
import fnmatch
import json
import pathlib
import shutil
import sys

docs_root = pathlib.Path(sys.argv[1]).resolve()
output_dir = pathlib.Path(sys.argv[2]).resolve()
source_repo = sys.argv[3]
source_revision = sys.argv[4]

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
exclusion_rules = out_of_scope_patterns + contract_only_patterns

all_files = sorted(
    path.relative_to(docs_root).as_posix()
    for path in docs_root.rglob("*")
    if path.is_file()
)

def matches_any(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, pattern) for pattern in patterns)

included_files: list[str] = []
excluded_files: list[str] = []
for relative_path in all_files:
    if matches_any(relative_path, include_patterns):
        included_files.append(relative_path)
    else:
        excluded_files.append(relative_path)

if not included_files:
    raise SystemExit("contract resolved zero included docs files")

for relative_path in included_files:
    source_path = docs_root / relative_path
    destination_path = output_dir / relative_path
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_path, destination_path)

manifest = {
    "module": "theorycloud",
    "subtree": "apptheory",
    "source_repo": source_repo,
    "source_revision": source_revision,
    "generated_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "included_file_count": len(included_files),
    "excluded_file_count": len(excluded_files),
    "exclusion_rules": exclusion_rules,
}

(output_dir / "source-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"included": len(included_files), "excluded": len(excluded_files)}))
PY

echo "staged AppTheory theorycloud subtree at ${OUTPUT_DIR}"
