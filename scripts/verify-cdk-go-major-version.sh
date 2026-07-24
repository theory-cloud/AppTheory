#!/usr/bin/env bash
# Purpose: prove a synthetic AppTheory 2.0 release produces the canonical jsii Go module and sync plan.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

for cmd in go npm npx python3 rsync; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "cdk-go-major-version: BLOCKED (${cmd} not found)" >&2
    exit 1
  fi
done

synthetic_version="2.0.0-rc"
canonical_module="github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v2"
tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

fixture_root="${tmp_dir}/fixture"
baseline_root="${tmp_dir}/baseline"
mkdir -p "${fixture_root}/scripts" "${baseline_root}/cdk" "${baseline_root}/cdk-go"

rsync -a \
  --exclude node_modules \
  --exclude cdk.out \
  cdk/ \
  "${fixture_root}/cdk/"
rsync -a cdk-go/ "${fixture_root}/cdk-go/"
cp VERSION "${fixture_root}/VERSION"
cp \
  scripts/render-release-artifact-sync-plan.py \
  scripts/update-cdk-generated.sh \
  scripts/verify-cdk-go.sh \
  "${fixture_root}/scripts/"

python3 - "${fixture_root}" "${synthetic_version}" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
version = sys.argv[2]
root.joinpath("VERSION").write_text(f"{version} # synthetic major-version fixture\n", encoding="utf-8")

for relative in ("cdk/package.json", "cdk/package-lock.json", "cdk/.jsii"):
    path = root / relative
    data = json.loads(path.read_text(encoding="utf-8"))
    data["version"] = version
    packages = data.get("packages")
    if isinstance(packages, dict) and isinstance(packages.get(""), dict):
        packages[""]["version"] = version
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

package = json.loads(root.joinpath("cdk/package.json").read_text(encoding="utf-8"))
go_target = package.get("jsii", {}).get("targets", {}).get("go", {})
if go_target.get("moduleName") != "github.com/theory-cloud/apptheory/cdk-go":
    raise SystemExit("cdk-go-major-version: FAIL (unexpected jsii Go moduleName)")
if go_target.get("packageName") != "apptheorycdk":
    raise SystemExit("cdk-go-major-version: FAIL (unexpected jsii Go packageName)")
PY

cp "${fixture_root}/cdk-go/apptheorycdk/bindings_test.go" "${tmp_dir}/bindings_test.go"
cp "${fixture_root}/cdk-go/apptheorycdk/generated_sync_test.go" "${tmp_dir}/generated_sync_test.go"

# Snapshot the Release Please-authored state before generated artifacts move.
cp "${fixture_root}/cdk/.jsii" "${baseline_root}/cdk/.jsii"
cp -a "${fixture_root}/cdk/lib" "${baseline_root}/cdk/lib"
cp -a "${fixture_root}/cdk-go/." "${baseline_root}/cdk-go/"

(cd "${fixture_root}" && bash scripts/update-cdk-generated.sh >/dev/null)

if [[ -e "${fixture_root}/cdk-go/go.mod" || -e "${fixture_root}/cdk-go/go.sum" ]]; then
  echo "cdk-go-major-version: FAIL (synthetic v2 generation retained legacy parent module files)" >&2
  exit 1
fi

canonical_go_mod="${fixture_root}/cdk-go/apptheorycdk/go.mod"
if [[ ! -f "${canonical_go_mod}" ]]; then
  echo "cdk-go-major-version: FAIL (synthetic v2 generation did not create nested go.mod)" >&2
  exit 1
fi
observed_module="$(awk '/^module[[:space:]]+/{print $2; exit}' "${canonical_go_mod}")"
if [[ "${observed_module}" != "${canonical_module}" ]]; then
  echo "cdk-go-major-version: FAIL (generated module '${observed_module}' != '${canonical_module}')" >&2
  exit 1
fi

for handwritten_test in bindings_test.go generated_sync_test.go; do
  if ! cmp -s \
    "${tmp_dir}/${handwritten_test}" \
    "${fixture_root}/cdk-go/apptheorycdk/${handwritten_test}"
  then
    echo "cdk-go-major-version: FAIL (synthetic generation did not preserve ${handwritten_test})" >&2
    exit 1
  fi
done

if grep -R -F \
  "github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/internal" \
  "${fixture_root}/cdk-go/apptheorycdk" \
  --include='*.go' >/dev/null
then
  echo "cdk-go-major-version: FAIL (generated v2 bindings contain legacy internal imports)" >&2
  exit 1
fi
if ! grep -R -F \
  "${canonical_module}/internal" \
  "${fixture_root}/cdk-go/apptheorycdk" \
  --include='*.go' >/dev/null
then
  echo "cdk-go-major-version: FAIL (generated v2 bindings do not use canonical internal imports)" >&2
  exit 1
fi

(cd "${fixture_root}" && bash scripts/verify-cdk-go.sh >/dev/null)

payload_file="${tmp_dir}/payload.json"
summary_file="${tmp_dir}/summary.json"
(
  cd "${fixture_root}"
  python3 scripts/render-release-artifact-sync-plan.py \
    --branch release-please--branches--premain \
    --expected-head 0000000000000000000000000000000000000000 \
    --repository theory-cloud/AppTheory \
    --message "chore(release): sync generated release artifacts" \
    --body "[skip ci]" \
    --mode fixture \
    --payload-file "${payload_file}" \
    --summary-file "${summary_file}" \
    --baseline-root "${baseline_root}"
)

python3 - "${summary_file}" "${payload_file}" <<'PY'
import json
import sys
from pathlib import Path

summary = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
payload = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
additions = set(summary.get("additions", []))
deletions = set(summary.get("deletions", []))

required_additions = {
    "cdk-go/apptheorycdk/go.mod",
    "cdk-go/apptheorycdk/go.sum",
}
required_deletions = {
    "cdk-go/go.mod",
    "cdk-go/go.sum",
}
if summary.get("additionCount", 0) <= 0:
    raise SystemExit("cdk-go-major-version: FAIL (synthetic GitHub artifact-sync plan is empty)")
if not required_additions.issubset(additions):
    raise SystemExit(
        "cdk-go-major-version: FAIL (artifact-sync plan is missing nested module additions: "
        f"{sorted(required_additions - additions)})"
    )
if not required_deletions.issubset(deletions):
    raise SystemExit(
        "cdk-go-major-version: FAIL (artifact-sync plan is missing legacy module deletions: "
        f"{sorted(required_deletions - deletions)})"
    )

file_changes = payload.get("variables", {}).get("input", {}).get("fileChanges", {})
if len(file_changes.get("additions", [])) != summary["additionCount"]:
    raise SystemExit("cdk-go-major-version: FAIL (payload addition count does not match summary)")
if len(file_changes.get("deletions", [])) != summary["deletionCount"]:
    raise SystemExit("cdk-go-major-version: FAIL (payload deletion count does not match summary)")

print(
    "cdk-go-major-version: PASS "
    f"(additions={summary['additionCount']}, deletions={summary['deletionCount']})"
)
PY
