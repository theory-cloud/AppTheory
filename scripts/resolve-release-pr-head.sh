#!/usr/bin/env bash
set -euo pipefail

# Bind a dispatched release-check run to the exact generated release pull
# request head it is verifying.
#
# A workflow_dispatch run starts on the head of the ref it is dispatched
# against, which is the generated release pull request's head branch. That is
# *not* proof that the run is verifying the pull request being gated: the branch
# could have moved between the read and the dispatch, or the dispatch could name
# a ref that belongs to a different pull request. This resolver reads the pull
# request by number and refuses unless every identity matches:
#
#   - the pull request is open;
#   - its base is a release branch this repository gates;
#   - its head repository is this repository (no fork can pass by branch name);
#   - its head branch and head SHA are exactly the dispatched ref and SHA.
#
# It only reads, and it never dispatches, merges, comments or writes to the
# pull request. The `GH_BIN` seam exists so the policy test can drive hostile
# answers through the real validation.

usage() {
  cat <<'USAGE'
Usage: bash scripts/resolve-release-pr-head.sh --pr NUMBER --ref-name NAME --ref-sha SHA [options]

Options:
  --repo OWNER/REPO        Repository. Defaults to $GITHUB_REPOSITORY or theory-cloud/AppTheory.
  --pr NUMBER              Generated release pull request number.
  --ref-name NAME          Value of $GITHUB_REF_NAME for the dispatched run.
  --ref-sha SHA            Value of $GITHUB_SHA for the dispatched run.
  --output FILE            Also append the resolved KEY=VALUE lines to FILE (for $GITHUB_OUTPUT).
  -h, --help               Show this help.

Prints one KEY=VALUE line per resolved field: base_ref, head_ref, base_repo,
head_repo, base_sha, head_sha, pr_number, pr_title, pr_state, pr_merged.
USAGE
}

repo="${GITHUB_REPOSITORY:-theory-cloud/AppTheory}"
pr_number=""
ref_name=""
ref_sha=""
output=""
gh_bin="${GH_BIN:-gh}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || { echo "resolve-release-pr-head: FAIL (--repo requires a value)" >&2; exit 2; }
      repo="$2"
      shift 2
      ;;
    --pr)
      [[ $# -ge 2 ]] || { echo "resolve-release-pr-head: FAIL (--pr requires a value)" >&2; exit 2; }
      pr_number="$2"
      shift 2
      ;;
    --ref-name)
      [[ $# -ge 2 ]] || { echo "resolve-release-pr-head: FAIL (--ref-name requires a value)" >&2; exit 2; }
      ref_name="$2"
      shift 2
      ;;
    --ref-sha)
      [[ $# -ge 2 ]] || { echo "resolve-release-pr-head: FAIL (--ref-sha requires a value)" >&2; exit 2; }
      ref_sha="$2"
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || { echo "resolve-release-pr-head: FAIL (--output requires a value)" >&2; exit 2; }
      output="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "resolve-release-pr-head: FAIL (unknown argument: $1)" >&2
      exit 2
      ;;
  esac
done

fail() {
  echo "resolve-release-pr-head: FAIL ($1)" >&2
  exit 1
}

[[ "${pr_number}" =~ ^[0-9]+$ ]] || fail "generated release PR number must be numeric, got ${pr_number:-<empty>}"
[[ -n "${ref_name}" ]] || fail "the dispatched ref name is required"
[[ "${ref_sha}" =~ ^[0-9a-f]{40}$ ]] || fail "the dispatched ref SHA must be a 40-character lowercase git SHA, got ${ref_sha:-<empty>}"

pr_json="$("${gh_bin}" api "repos/${repo}/pulls/${pr_number}")" || fail "cannot read pull request #${pr_number} in ${repo}"

parsed="$(
  PR_JSON="${pr_json}" python3 - "${repo}" "${pr_number}" "${ref_name}" "${ref_sha}" <<'PY'
import json
import os
import sys

repo, pr_number, ref_name, ref_sha = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
data = json.loads(os.environ["PR_JSON"])


def fail(message: str) -> None:
    print(f"resolve-release-pr-head: FAIL ({message})", file=sys.stderr)
    raise SystemExit(1)


state = str(data.get("state") or "")
base = data.get("base") or {}
head = data.get("head") or {}
base_ref = str(base.get("ref") or "")
head_ref = str(head.get("ref") or "")
base_repo = str((base.get("repo") or {}).get("full_name") or "")
head_repo = str((head.get("repo") or {}).get("full_name") or "")
base_sha = str(base.get("sha") or "")
head_sha = str(head.get("sha") or "")
title = str(data.get("title") or "")

if str(data.get("number") or "") != pr_number:
    fail(f"answered pull request {data.get('number')} for requested #{pr_number}")
if state != "open":
    fail(f"generated release PR #{pr_number} is {state or 'unknown'}, not open")
if base_ref not in ("premain", "main"):
    fail(f"generated release PR #{pr_number} targets {base_ref or '<empty>'}, not a release branch")
if head_repo != repo:
    fail(f"generated release PR #{pr_number} head repository {head_repo or '<empty>'} != {repo}")
if head_ref != ref_name:
    fail(f"dispatched ref {ref_name} != generated release PR head {head_ref or '<empty>'}")
if head_sha != ref_sha:
    fail(f"dispatched ref SHA {ref_sha} != generated release PR head {head_sha or '<empty>'}")
if "\n" in title or "\r" in title:
    fail("generated release PR title must be a single line")

for key, value in (
    ("base_ref", base_ref),
    ("head_ref", head_ref),
    ("base_repo", base_repo),
    ("head_repo", head_repo),
    ("base_sha", base_sha),
    ("head_sha", head_sha),
    ("pr_number", pr_number),
    ("pr_title", title),
    ("pr_state", state),
    ("pr_merged", "true" if data.get("merged") else "false"),
):
    print(f"{key}={value}")
PY
)" || exit 1

for required in base_ref head_ref base_repo head_repo base_sha head_sha pr_number pr_state pr_merged; do
  grep -q "^${required}=" <<<"${parsed}" || fail "resolved context is missing ${required}"
done

printf '%s\n' "${parsed}"
if [[ -n "${output}" ]]; then
  printf '%s\n' "${parsed}" >>"${output}"
fi

echo "resolve-release-pr-head: PASS (#${pr_number} ${ref_name}@${ref_sha})" >&2
