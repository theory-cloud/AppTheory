#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

version_line_re='^[[:space:]]*([0-9]+\.[0-9]+\.[0-9]+(-rc(\.[0-9]+)?)?)[[:space:]]*(#.*)?$'
rc_version_re='^[0-9]+\.[0-9]+\.[0-9]+-rc(\.[0-9]+)?$'
stable_version_re='^[0-9]+\.[0-9]+\.[0-9]+$'

parse_version_value() {
  local raw="$1"

  raw="${raw//$'\r'/}"
  raw="${raw//$'\n'/}"
  if [[ "${raw}" =~ ${version_line_re} ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi

  return 1
}

is_rc_version() {
  [[ "$1" =~ ${rc_version_re} ]]
}

is_stable_version() {
  [[ "$1" =~ ${stable_version_re} ]]
}

self_test_version_parser() {
  local parsed

  parsed="$(parse_version_value '1.12.2-rc # x-release-please-version')"
  [[ "${parsed}" == "1.12.2-rc" ]] || {
    echo "release-pr-postcondition: FAIL (self-test annotated RC parsed as ${parsed})" >&2
    return 1
  }
  is_rc_version "${parsed}" || {
    echo "release-pr-postcondition: FAIL (self-test annotated RC was not accepted as RC)" >&2
    return 1
  }
  ! is_stable_version "${parsed}" || {
    echo "release-pr-postcondition: FAIL (self-test annotated RC was accepted as stable)" >&2
    return 1
  }

  parsed="$(parse_version_value '1.12.2-rc.7 # x-release-please-version')"
  [[ "${parsed}" == "1.12.2-rc.7" ]] || {
    echo "release-pr-postcondition: FAIL (self-test numbered annotated RC parsed as ${parsed})" >&2
    return 1
  }
  is_rc_version "${parsed}" || {
    echo "release-pr-postcondition: FAIL (self-test numbered annotated RC was not accepted as RC)" >&2
    return 1
  }

  parsed="$(parse_version_value '1.12.2 # x-release-please-version')"
  [[ "${parsed}" == "1.12.2" ]] || {
    echo "release-pr-postcondition: FAIL (self-test annotated stable parsed as ${parsed})" >&2
    return 1
  }
  is_stable_version "${parsed}" || {
    echo "release-pr-postcondition: FAIL (self-test annotated stable was not accepted as stable)" >&2
    return 1
  }
  ! is_rc_version "${parsed}" || {
    echo "release-pr-postcondition: FAIL (self-test annotated stable was accepted as RC)" >&2
    return 1
  }

  if parse_version_value '1.12.2-rcx # x-release-please-version' >/dev/null; then
    echo "release-pr-postcondition: FAIL (self-test malformed RC was parsed)" >&2
    return 1
  fi

  echo "release-pr-postcondition: PASS (self-test VERSION parser; annotated RC accepted and stable/RC mismatches rejected)"
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test_version_parser
  exit $?
fi

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
version_raw="$(printf '%s' "${version_b64}" | base64 --decode | tr -d '\r\n')"
if ! version="$(parse_version_value "${version_raw}")"; then
  echo "release-pr-postcondition: FAIL (generated ${base_branch} release PR #${pr_number} VERSION ${version_raw} does not start with a supported stable/RC semver value)" >&2
  exit 1
fi

rc_re='(^|[^0-9A-Za-z.])v?[0-9]+\.[0-9]+\.[0-9]+-rc(\.[0-9]+)?([^0-9A-Za-z.]|$)'

case "${channel}" in
  prerelease)
    if ! is_rc_version "${version}"; then
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
    if ! is_stable_version "${version}"; then
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
