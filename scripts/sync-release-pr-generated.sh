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

open_pr_count="$(
  gh pr list \
    --state open \
    --head "${release_branch}" \
    --json number \
    --jq 'length'
)"

if [[ "${open_pr_count}" == "0" ]]; then
  echo "sync-release-pr-generated: SKIP (no open PR for ${release_branch})"
  exit 0
fi

git fetch origin "${release_branch}"
git switch --detach FETCH_HEAD

scripts/update-cdk-generated.sh >/dev/null

if git diff --quiet -- cdk/.jsii cdk/lib cdk-go/apptheorycdk; then
  echo "sync-release-pr-generated: PASS (${release_branch} already in sync)"
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add cdk/.jsii cdk/lib cdk-go/apptheorycdk
git commit -m "chore(release): sync generated cdk artifacts"
git push origin HEAD:"${release_branch}"

echo "sync-release-pr-generated: PASS (${release_branch} updated)"
