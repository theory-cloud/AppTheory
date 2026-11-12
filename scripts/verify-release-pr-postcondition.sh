#!/usr/bin/env bash
# Purpose: verify generated release-please PRs satisfy postcondition requirements.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
repo_root="$(pwd)"
release_generated_messages="${repo_root}/scripts/lib/release-generated-messages.py"

version_line_re='^[[:space:]]*([0-9]+\.[0-9]+\.[0-9]+(-rc(\.[0-9]+)?)?)[[:space:]]*(#.*)?$'
rc_version_re='^[0-9]+\.[0-9]+\.[0-9]+-rc(\.[0-9]+)?$'
stable_version_re='^[0-9]+\.[0-9]+\.[0-9]+$'
releasable_subject_re='^(feat|fix|perf)(\([^)]+\))?(!)?: '

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

manifest_version() {
  local manifest_path="$1"

  python3 - "${manifest_path}" <<'PY'
import json
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
version = json.loads(manifest_path.read_text(encoding="utf-8")).get(".", "")
if not version:
    raise SystemExit(f"missing release-please version in {manifest_path}")
print(version)
PY
}

baseline_tag_from_manifest() {
  local manifest_path="$1"
  local version

  version="$(manifest_version "${manifest_path}")"
  printf 'v%s\n' "${version#v}"
}

fetch_base_branch_and_tags() {
  local base_branch="$1"

  if git remote get-url origin >/dev/null 2>&1; then
    git fetch --force --tags origin "+refs/heads/${base_branch}:refs/remotes/origin/${base_branch}" >/dev/null 2>&1
  fi
}

resolve_base_ref() {
  local base_branch="$1"

  if git rev-parse --verify --quiet "origin/${base_branch}^{commit}" >/dev/null; then
    printf 'origin/%s\n' "${base_branch}"
    return 0
  fi

  if git rev-parse --verify --quiet "${base_branch}^{commit}" >/dev/null; then
    printf '%s\n' "${base_branch}"
    return 0
  fi

  return 1
}

has_releasable_commits_since() {
  local baseline="$1"
  local base_ref="$2"
  local commit_subjects

  # Same user-facing predicate as the prerelease readiness gate:
  # git log --no-merges --format=%s <baseline>..<base_branch> |
  #   grep -Eq '^(feat|fix|perf)(\([^)]+\))?(!)?: '
  #
  # The baseline is the recorded manifest tag, so tagged release history cannot
  # count. Any commit after that immutable tag is a new change and keeps the
  # range releasable, including a generated fix-typed release or sync commit:
  # a generated subject is never excused from publication by its shape.
  #
  # Keep the subjects in memory instead of piping directly into grep -q so
  # pipefail cannot turn a matching early grep exit into a false negative.
  commit_subjects="$(git log --no-merges --format=%s "${baseline}..${base_ref}")"
  grep -Eq "${releasable_subject_re}" <<<"${commit_subjects}"
}

verify_no_open_release_pr_is_legitimate_noop() {
  local base_branch="$1"
  local release_branch="$2"
  local expected_shape="$3"
  local noop_message="$4"
  local manifest_path="$5"
  local baseline
  local base_ref

  if ! baseline="$(baseline_tag_from_manifest "${manifest_path}")"; then
    echo "release-pr-postcondition: FAIL (could not read ${manifest_path} to derive the ${base_branch} release baseline)" >&2
    return 1
  fi

  if ! fetch_base_branch_and_tags "${base_branch}"; then
    echo "release-pr-postcondition: FAIL (${noop_message}; could not fetch ${base_branch} and tags to check commits since ${baseline})" >&2
    return 1
  fi

  if ! git rev-parse --verify --quiet "${baseline}^{commit}" >/dev/null; then
    echo "release-pr-postcondition: FAIL (${noop_message}; recorded ${base_branch} manifest baseline tag ${baseline} is missing, so no-op cannot be proven)" >&2
    return 1
  fi

  if ! base_ref="$(resolve_base_ref "${base_branch}")"; then
    echo "release-pr-postcondition: FAIL (${noop_message}; could not resolve ${base_branch} to check commits since ${baseline})" >&2
    return 1
  fi

  if has_releasable_commits_since "${baseline}" "${base_ref}"; then
    echo "release-pr-postcondition: FAIL (${noop_message}; expected an open generated ${expected_shape} release-please PR ${release_branch} -> ${base_branch})" >&2
    return 1
  fi

  echo "release-pr-postcondition: PASS (legitimate no-op; nothing user-facing to release on ${base_branch} since ${baseline})"
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

commit_self_test_change() {
  local subject="$1"
  local path="$2"
  local content="$3"

  printf '%s\n' "${content}" >"${path}"
  git add "${path}"
  git \
    -c user.name="AppTheory Release Self Test" \
    -c user.email="apptheory-release-self-test@example.invalid" \
    commit -q -m "${subject}"
}

self_test_no_open_release_pr_channel() {
  local channel="$1"
  local base_branch="$2"
  local manifest_path="$3"
  local expected_shape="$4"
  local noop_message="$5"
  local release_branch="$6"
  local tmp
  local output

  tmp="$(mktemp -d)"
  (
    cd "${tmp}"
    git init -q
    git checkout -q -b "${base_branch}"
    commit_self_test_change "chore: seed release baseline" "self-test.txt" "baseline"
    # The generated release and artifact-sync commits that produced the baseline
    # are inside the immutable tag, so they are published history.
    commit_self_test_change "fix(release): sync generated release artifacts" "self-test.txt" "generated-sync-in-tag"
    commit_self_test_change "fix(${base_branch}): release 1.0.0" "self-test.txt" "generated-release-in-tag"
    git update-ref refs/tags/v1.0.0 HEAD

    python3 - "${manifest_path}" <<'PY'
import json
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(json.dumps({".": "1.0.0"}) + "\n", encoding="utf-8")
PY

    commit_self_test_change "docs: internal release note" "self-test.txt" "docs"
    if ! output="$(
      verify_no_open_release_pr_is_legitimate_noop \
        "${base_branch}" \
        "${release_branch}" \
        "${expected_shape}" \
        "${noop_message}" \
        "${manifest_path}" 2>&1
    )"; then
      printf '%s\n' "${output}" >&2
      echo "release-pr-postcondition: FAIL (self-test ${channel} legitimate no-op was rejected)" >&2
      return 1
    fi
    grep -Fq "legitimate no-op" <<<"${output}" || {
      printf '%s\n' "${output}" >&2
      echo "release-pr-postcondition: FAIL (self-test ${channel} no-op did not report legitimate no-op)" >&2
      return 1
    }
    echo "release-pr-postcondition: PASS (self-test ${channel} empty release-please PR with only published history passed)"

    # A generated fix-typed commit created after the immutable tag is a new
    # post-tag change: its subject must never excuse it from publication.
    commit_self_test_change "fix(release): sync generated release artifacts" "self-test.txt" "generated-sync-after"
    if output="$(
      verify_no_open_release_pr_is_legitimate_noop \
        "${base_branch}" \
        "${release_branch}" \
        "${expected_shape}" \
        "${noop_message}" \
        "${manifest_path}" 2>&1
    )"; then
      printf '%s\n' "${output}" >&2
      echo "release-pr-postcondition: FAIL (self-test ${channel} generated artifact sync after the tag was accepted as a no-op)" >&2
      return 1
    fi
    grep -Fq "release-pr-postcondition: FAIL (${noop_message}; expected an open generated ${expected_shape} release-please PR ${release_branch} -> ${base_branch})" <<<"${output}" || {
      printf '%s\n' "${output}" >&2
      echo "release-pr-postcondition: FAIL (self-test ${channel} generated artifact sync after the tag did not preserve the fail-closed message)" >&2
      return 1
    }
    echo "release-pr-postcondition: PASS (self-test ${channel} generated artifact sync after the tag failed closed)"

    commit_self_test_change "fix(${base_branch}): release 1.0.1" "self-test.txt" "generated-release-after"
    if output="$(
      verify_no_open_release_pr_is_legitimate_noop \
        "${base_branch}" \
        "${release_branch}" \
        "${expected_shape}" \
        "${noop_message}" \
        "${manifest_path}" 2>&1
    )"; then
      printf '%s\n' "${output}" >&2
      echo "release-pr-postcondition: FAIL (self-test ${channel} generated release commit after the tag was accepted as a no-op)" >&2
      return 1
    fi
    grep -Fq "release-pr-postcondition: FAIL (${noop_message}; expected an open generated ${expected_shape} release-please PR ${release_branch} -> ${base_branch})" <<<"${output}" || {
      printf '%s\n' "${output}" >&2
      echo "release-pr-postcondition: FAIL (self-test ${channel} generated release commit after the tag did not preserve the fail-closed message)" >&2
      return 1
    }
    echo "release-pr-postcondition: PASS (self-test ${channel} generated release commit after the tag failed closed)"

    # A human fix whose subject resembles a generated one must still count.
    commit_self_test_change "fix(parser): release v2 of caching" "self-test.txt" "lookalike"
    if output="$(
      verify_no_open_release_pr_is_legitimate_noop \
        "${base_branch}" \
        "${release_branch}" \
        "${expected_shape}" \
        "${noop_message}" \
        "${manifest_path}" 2>&1
    )"; then
      printf '%s\n' "${output}" >&2
      echo "release-pr-postcondition: FAIL (self-test ${channel} lookalike fix was accepted as a no-op)" >&2
      return 1
    fi
    grep -Fq "release-pr-postcondition: FAIL (${noop_message}; expected an open generated ${expected_shape} release-please PR ${release_branch} -> ${base_branch})" <<<"${output}" || {
      printf '%s\n' "${output}" >&2
      echo "release-pr-postcondition: FAIL (self-test ${channel} lookalike fix did not preserve the fail-closed message)" >&2
      return 1
    }
    echo "release-pr-postcondition: PASS (self-test ${channel} lookalike fix failed closed)"

    commit_self_test_change "fix: self-test releasable change" "self-test.txt" "fix"
    if output="$(
      verify_no_open_release_pr_is_legitimate_noop \
        "${base_branch}" \
        "${release_branch}" \
        "${expected_shape}" \
        "${noop_message}" \
        "${manifest_path}" 2>&1
    )"; then
      printf '%s\n' "${output}" >&2
      echo "release-pr-postcondition: FAIL (self-test ${channel} genuine miss was accepted)" >&2
      return 1
    fi
    grep -Fq "release-pr-postcondition: FAIL (${noop_message}; expected an open generated ${expected_shape} release-please PR ${release_branch} -> ${base_branch})" <<<"${output}" || {
      printf '%s\n' "${output}" >&2
      echo "release-pr-postcondition: FAIL (self-test ${channel} genuine miss did not preserve the fail-closed message)" >&2
      return 1
    }
    echo "release-pr-postcondition: PASS (self-test ${channel} empty release-please PR with a user-facing commit failed closed)"
  )
  rm -rf "${tmp}"
}

run_self_tests() {
  self_test_version_parser
  self_test_no_open_release_pr_channel \
    "prerelease" \
    "premain" \
    ".release-please-manifest.premain.json" \
    "RC" \
    "release-please no-op is a failed RC gate" \
    "release-please--branches--premain"
  self_test_no_open_release_pr_channel \
    "stable" \
    "main" \
    ".release-please-manifest.json" \
    "stable" \
    "release-please no-op is a failed stable gate" \
    "release-please--branches--main"
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_tests
  exit $?
fi

channel="${1:-}"
case "${channel}" in
  prerelease)
    base_branch="premain"
    release_branch="release-please--branches--premain"
    expected_shape="RC"
    noop_message="release-please no-op is a failed RC gate"
    manifest_path=".release-please-manifest.premain.json"
    config_path="release-please-config.premain.json"
    ;;
  stable)
    base_branch="main"
    release_branch="release-please--branches--main"
    expected_shape="stable"
    noop_message="release-please no-op is a failed stable gate"
    manifest_path=".release-please-manifest.json"
    config_path="release-please-config.json"
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
  verify_no_open_release_pr_is_legitimate_noop \
    "${base_branch}" \
    "${release_branch}" \
    "${expected_shape}" \
    "${noop_message}" \
    "${manifest_path}"
  exit $?
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

# The generated release PR title is also the release-branch commit subject
# (pinned release-please 17.11.2 uses releasePullRequest.title.toString() as the
# commit message). Bind both to the lane's configured pull-request-title-pattern
# so a non-release-driving generated message cannot pass as a release gate. The
# comparison is exact: the scope is the lane's own main/premain branch and the
# version is the strict semver parsed from the release branch VERSION file.
if ! expected_title="$(
  python3 "${release_generated_messages}" render-title \
    --config "${config_path}" \
    --branch "${base_branch}" \
    --version "${version}" 2>&1
)"; then
  echo "release-pr-postcondition: FAIL (could not render the configured release PR title for ${base_branch}: ${expected_title})" >&2
  exit 1
fi

if ! [[ "${expected_title}" =~ ${releasable_subject_re} ]]; then
  echo "release-pr-postcondition: FAIL (configured release PR title for ${base_branch} is not release-driving: ${expected_title})" >&2
  exit 1
fi

if [[ "${expected_title}" != "fix(${base_branch}): "* ]]; then
  echo "release-pr-postcondition: FAIL (configured release PR title for ${base_branch} does not carry the exact lane scope: ${expected_title})" >&2
  exit 1
fi

if [[ "${title}" != "${expected_title}" ]]; then
  echo "release-pr-postcondition: FAIL (generated ${base_branch} release PR #${pr_number} title ${title} != configured release-driving title ${expected_title})" >&2
  exit 1
fi

if ! sync_message="$(python3 "${release_generated_messages}" sync-message 2>&1)"; then
  echo "release-pr-postcondition: FAIL (could not read the generated artifact sync commit subject: ${sync_message})" >&2
  exit 1
fi

pr_commit_headlines="$(
  gh pr view --repo "${repository}" "${pr_number}" --json commits --jq '.commits[].messageHeadline'
)"
if ! grep -Fxq -- "${title}" <<<"${pr_commit_headlines}"; then
  echo "release-pr-postcondition: FAIL (generated ${base_branch} release PR #${pr_number} has no release-branch commit subject equal to the generated title ${title})" >&2
  exit 1
fi

while IFS= read -r headline; do
  [[ -z "${headline}" ]] && continue
  if [[ "${headline}" == "${title}" || "${headline}" == "${sync_message}" ]]; then
    continue
  fi
  echo "release-pr-postcondition: FAIL (generated ${base_branch} release PR #${pr_number} contains an unexpected release-branch commit subject: ${headline})" >&2
  exit 1
done <<<"${pr_commit_headlines}"

echo "release-pr-postcondition: PASS (${expected_shape} PR #${pr_number}, VERSION=${version})"
