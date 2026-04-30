#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

release_branch="${1:-}"
if [[ -z "${release_branch}" ]]; then
  echo "sync-release-pr-generated: FAIL (usage: $0 <release-branch>)" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "sync-release-pr-generated: FAIL (gh not found)" >&2
  exit 1
fi

pr_line="$(
  gh pr list \
    --state open \
    --head "${release_branch}" \
    --json number,isDraft \
    --jq '.[] | "\(.number)	\(.isDraft)"' \
    | head -n 1
)"

if [[ -z "${pr_line}" ]]; then
  echo "sync-release-pr-generated: SKIP (no open PR for ${release_branch})"
  exit 0
fi

pr_number="${pr_line%%$'\t'*}"

pr_state_line() {
  gh pr view "${pr_number}" \
    --json state,isDraft \
    --jq '"\(.state)	\(.isDraft)"' \
    2>/dev/null || true
}

git fetch origin "${release_branch}"
git switch --detach FETCH_HEAD

scripts/update-cdk-generated.sh >/dev/null

changed=false
if ! git diff --quiet -- cdk/.jsii cdk/lib cdk-go/apptheorycdk; then
  changed=true

  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git add cdk/.jsii cdk/lib cdk-go/apptheorycdk
  git commit -m "chore(release): sync generated cdk artifacts"
fi

go test ./cdk-go/apptheorycdk

current_pr_line="$(pr_state_line)"
if [[ -z "${current_pr_line}" ]]; then
  echo "sync-release-pr-generated: FAIL (PR #${pr_number} disappeared before generated artifacts could be synced)"
  exit 1
fi

current_pr_state="${current_pr_line%%$'\t'*}"
current_pr_is_draft="${current_pr_line#*$'\t'}"

if [[ "${current_pr_state}" != "OPEN" ]]; then
  echo "sync-release-pr-generated: FAIL (PR #${pr_number} is ${current_pr_state} before generated artifacts could be synced)"
  exit 1
fi

if [[ "${changed}" == "true" ]]; then
  git push origin HEAD:"${release_branch}"
fi

if [[ "${current_pr_is_draft}" == "true" ]]; then
  gh pr ready "${pr_number}"
fi

echo "sync-release-pr-generated: PASS (${release_branch} updated)"
