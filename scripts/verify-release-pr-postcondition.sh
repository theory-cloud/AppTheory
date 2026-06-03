#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

channel="${1:-}"
case "${channel}" in
  prerelease)
    base_branch="premain"
    release_branch="release-please--branches--premain"
    expected_shape="RC"
    noop_message="release-please no-op is a failed RC gate"
    ;;
  stable)
    base_branch="main"
    release_branch="release-please--branches--main"
    expected_shape="stable"
    noop_message="release-please no-op is a failed stable gate"
    ;;
  *)
    echo "release-pr-postcondition: FAIL (usage: $0 prerelease|stable)" >&2
    exit 1
    ;;
esac

if ! command -v gh >/dev/null 2>&1; then
  echo "release-pr-postcondition: FAIL (gh not found)" >&2
  exit 1
fi

repository="${GITHUB_REPOSITORY:-}"
if [[ -z "${repository}" ]]; then
  repository="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
fi

pr_number="$(
  gh pr list \
    --repo "${repository}" \
    --state open \
    --base "${base_branch}" \
    --head "${release_branch}" \
    --json number \
    --jq '.[0].number // ""'
)"

if [[ -z "${pr_number}" ]]; then
  echo "release-pr-postcondition: FAIL (${noop_message}; expected an open generated ${expected_shape} release-please PR ${release_branch} -> ${base_branch})" >&2
  exit 1
fi

title="$(gh pr view --repo "${repository}" "${pr_number}" --json title --jq '.title')"
encoded_ref="$(
  python3 - "${release_branch}" <<'PY'
import sys
import urllib.parse

print(urllib.parse.quote(sys.argv[1], safe=""))
PY
)"
version_b64="$(gh api "repos/${repository}/contents/VERSION?ref=${encoded_ref}" --jq '.content // ""' | tr -d '\n')"
version="$(printf '%s' "${version_b64}" | base64 --decode | tr -d '\r\n')"

rc_re='(^|[^0-9A-Za-z.])v?[0-9]+\.[0-9]+\.[0-9]+-rc(\.[0-9]+)?([^0-9A-Za-z.]|$)'
stable_re='^[0-9]+\.[0-9]+\.[0-9]+$'

case "${channel}" in
  prerelease)
    if ! [[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+-rc(\.[0-9]+)?$ ]]; then
      echo "release-pr-postcondition: FAIL (generated premain release PR #${pr_number} VERSION ${version} is not RC-shaped)" >&2
      exit 1
    fi
    if ! [[ "${title}" =~ ${rc_re} ]]; then
      echo "release-pr-postcondition: FAIL (generated premain release PR #${pr_number} title does not advertise an RC version: ${title})" >&2
      exit 1
    fi
    ;;
  stable)
    if [[ "${version}" =~ -rc(\.|$) ]]; then
      echo "release-pr-postcondition: FAIL (generated main release PR #${pr_number} VERSION ${version} is RC-shaped; main owns stable releases only)" >&2
      exit 1
    fi
    if ! [[ "${version}" =~ ${stable_re} ]]; then
      echo "release-pr-postcondition: FAIL (generated main release PR #${pr_number} VERSION ${version} is not stable semver)" >&2
      exit 1
    fi
    if [[ "${title}" =~ ${rc_re} ]]; then
      echo "release-pr-postcondition: FAIL (generated main release PR #${pr_number} title is RC-shaped; main owns stable releases only: ${title})" >&2
      exit 1
    fi
    ;;
esac

echo "release-pr-postcondition: PASS (${expected_shape} PR #${pr_number}, VERSION=${version})"
