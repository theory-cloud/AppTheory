#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

releasable_subject_re='^(feat|fix|perf)(\([^)]+\))?(!)?: '

is_rc_tag() {
  [[ "${1:-}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+-rc(\.[0-9]+)?$ ]]
}

is_stable_tag() {
  [[ "${1:-}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]
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
  # Keep the subjects in memory instead of piping directly into grep -q so
  # pipefail cannot turn a matching early grep exit into a false negative.
  commit_subjects="$(git log --no-merges --format=%s "${baseline}..${base_ref}")"
  grep -Eq "${releasable_subject_re}" <<<"${commit_subjects}"
}

is_published_release() {
  local tag="$1"
  local release_state

  if ! command -v gh >/dev/null 2>&1; then
    return 1
  fi

  if ! release_state="$(
    gh release view "${tag}" \
      --json isDraft,isPrerelease \
      --jq 'if (.isDraft == false and .isPrerelease == false) then "published-stable" else "" end' \
      2>/dev/null
  )"; then
    return 1
  fi

  [[ "${release_state}" == "published-stable" ]]
}

is_published_prerelease() {
  local tag="$1"
  local release_state

  if ! is_rc_tag "${tag}"; then
    return 1
  fi

  if ! command -v gh >/dev/null 2>&1; then
    return 1
  fi

  if ! release_state="$(
    gh release view "${tag}" \
      --json isDraft,isPrerelease \
      --jq 'if (.isDraft == false and .isPrerelease == true) then "published-prerelease" else "" end' \
      2>/dev/null
  )"; then
    return 1
  fi

  [[ "${release_state}" == "published-prerelease" ]]
}

stable_already_published_noop_is_legitimate() {
  local base_ref

  if ! is_stable_tag "${expected_tag}"; then
    return 1
  fi

  if ! is_published_release "${expected_tag}"; then
    return 1
  fi

  if ! fetch_base_branch_and_tags "main"; then
    return 1
  fi

  if ! git rev-parse --verify --quiet "${expected_tag}^{commit}" >/dev/null; then
    return 1
  fi

  if ! base_ref="$(resolve_base_ref "main")"; then
    return 1
  fi

  if has_releasable_commits_since "${expected_tag}" "${base_ref}"; then
    return 1
  fi

  echo "release-publish-postcondition: PASS (already published ${expected_tag}; legitimate no-op)"
}

prerelease_already_published_noop_is_legitimate() {
  local base_ref

  if ! is_rc_tag "${expected_tag}"; then
    return 1
  fi

  if ! is_published_prerelease "${expected_tag}"; then
    return 1
  fi

  if ! fetch_base_branch_and_tags "premain"; then
    return 1
  fi

  if ! git rev-parse --verify --quiet "${expected_tag}^{commit}" >/dev/null; then
    return 1
  fi

  if ! base_ref="$(resolve_base_ref "premain")"; then
    return 1
  fi

  if has_releasable_commits_since "${expected_tag}" "${base_ref}"; then
    return 1
  fi

  echo "release-publish-postcondition: PASS (already published ${expected_tag}; legitimate no-op)"
}

require_created_tag() {
  local expected_shape="$1"

  if [[ "${release_created}" != "true" ]]; then
    if [[ "${expected_shape}" == "stable" ]] && stable_already_published_noop_is_legitimate; then
      return 0
    fi
    if [[ "${expected_shape}" == "RC" ]] && prerelease_already_published_noop_is_legitimate; then
      return 0
    fi

    echo "release-publish-postcondition: FAIL (release-please no-op is a failed ${expected_shape} publish gate; release_created=${release_created:-<empty>})" >&2
    return 1
  fi

  if [[ -z "${tag_name}" ]]; then
    echo "release-publish-postcondition: FAIL (${expected_shape} publish gate created a release without tag_name)" >&2
    return 1
  fi

  if [[ "${tag_name}" != "${expected_tag}" ]]; then
    echo "release-publish-postcondition: FAIL (${expected_shape} tag ${tag_name} != expected ${expected_tag})" >&2
    return 1
  fi
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

self_test_stable_already_published_noop() {
  local tmp
  local output

  tmp="$(mktemp -d)"
  (
    cd "${tmp}"
    git init -q
    git checkout -q -b main
    commit_self_test_change "chore: seed stable baseline" "self-test.txt" "baseline"
    git update-ref refs/tags/v1.0.0 HEAD

    expected_tag="v1.0.0"
    release_created="false"
    tag_name=""

    is_published_release() {
      [[ "${1:-}" == "v1.0.0" ]]
    }

    commit_self_test_change "docs: internal release note" "self-test.txt" "docs"
    if ! output="$(require_created_tag "stable" 2>&1)"; then
      printf '%s\n' "${output}" >&2
      echo "release-publish-postcondition: FAIL (self-test stable already-published no-op was rejected)" >&2
      return 1
    fi
    grep -Fq "already published v1.0.0; legitimate no-op" <<<"${output}" || {
      printf '%s\n' "${output}" >&2
      echo "release-publish-postcondition: FAIL (self-test stable no-op did not report already-published tolerance)" >&2
      return 1
    }
    echo "release-publish-postcondition: PASS (self-test stable already-published tag with zero user-facing commits passed)"

    commit_self_test_change "perf: self-test releasable change" "self-test.txt" "perf"
    if output="$(require_created_tag "stable" 2>&1)"; then
      printf '%s\n' "${output}" >&2
      echo "release-publish-postcondition: FAIL (self-test stable genuine miss was accepted)" >&2
      return 1
    fi
    grep -Fq "release-publish-postcondition: FAIL (release-please no-op is a failed stable publish gate; release_created=false)" <<<"${output}" || {
      printf '%s\n' "${output}" >&2
      echo "release-publish-postcondition: FAIL (self-test stable genuine miss did not preserve the fail-closed message)" >&2
      return 1
    }
    echo "release-publish-postcondition: PASS (self-test stable already-published tag with a user-facing commit failed closed)"
  )
  rm -rf "${tmp}"
}

self_test_prerelease_already_published_noop() {
  local tmp
  local output

  tmp="$(mktemp -d)"
  (
    cd "${tmp}"
    git init -q
    git checkout -q -b premain
    commit_self_test_change "chore: seed RC baseline" "self-test.txt" "baseline"
    git update-ref refs/tags/v1.0.0-rc HEAD

    expected_tag="v1.0.0-rc"
    release_created="false"
    tag_name=""

    is_published_prerelease() {
      [[ "${1:-}" == "v1.0.0-rc" ]]
    }

    commit_self_test_change "docs: internal RC note" "self-test.txt" "docs"
    if ! output="$(require_created_tag "RC" 2>&1)"; then
      printf '%s\n' "${output}" >&2
      echo "release-publish-postcondition: FAIL (self-test prerelease already-published no-op was rejected)" >&2
      return 1
    fi
    grep -Fq "already published v1.0.0-rc; legitimate no-op" <<<"${output}" || {
      printf '%s\n' "${output}" >&2
      echo "release-publish-postcondition: FAIL (self-test prerelease no-op did not report already-published tolerance)" >&2
      return 1
    }
    echo "release-publish-postcondition: PASS (self-test prerelease already-published tag with zero user-facing commits passed)"

    commit_self_test_change "fix: self-test releasable change" "self-test.txt" "fix"
    if output="$(require_created_tag "RC" 2>&1)"; then
      printf '%s\n' "${output}" >&2
      echo "release-publish-postcondition: FAIL (self-test prerelease genuine miss was accepted)" >&2
      return 1
    fi
    grep -Fq "release-publish-postcondition: FAIL (release-please no-op is a failed RC publish gate; release_created=false)" <<<"${output}" || {
      printf '%s\n' "${output}" >&2
      echo "release-publish-postcondition: FAIL (self-test prerelease genuine miss did not preserve the fail-closed message)" >&2
      return 1
    }
    echo "release-publish-postcondition: PASS (self-test prerelease already-published tag with a user-facing commit failed closed)"
  )
  rm -rf "${tmp}"
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test_stable_already_published_noop
  self_test_prerelease_already_published_noop
  exit $?
fi

channel="${1:-}"
release_created="${2:-}"
tag_name="${3:-}"

case "${channel}" in
  prerelease|stable) ;;
  *)
    echo "release-publish-postcondition: FAIL (usage: $0 prerelease|stable <release_created> <tag_name>)" >&2
    exit 1
    ;;
esac

expected_tag="v$(./scripts/read-version.sh)"

case "${channel}" in
  prerelease)
    if is_rc_tag "${expected_tag}"; then
      require_created_tag "RC" || exit 1
      if [[ "${release_created}" != "true" ]]; then
        exit 0
      fi
      if ! is_rc_tag "${tag_name}"; then
        echo "release-publish-postcondition: FAIL (prerelease tag ${tag_name} is not RC-shaped)" >&2
        exit 1
      fi
      echo "release-publish-postcondition: PASS (RC ${tag_name})"
      exit 0
    fi

    if [[ "${release_created}" == "true" ]]; then
      echo "release-publish-postcondition: FAIL (premain must not publish stable-shaped tag ${tag_name:-<empty>})" >&2
      exit 1
    fi

    echo "release-publish-postcondition: PASS (pending RC PR generation for ${expected_tag})"
    ;;
  stable)
    if is_rc_tag "${expected_tag}"; then
      if [[ "${release_created}" == "true" ]]; then
        echo "release-publish-postcondition: FAIL (main must never create or advertise RC tag ${tag_name:-<empty>})" >&2
        exit 1
      fi
      echo "release-publish-postcondition: PASS (pending stable PR generation from RC handoff ${expected_tag})"
      exit 0
    fi

    require_created_tag "stable" || exit 1
    if [[ "${release_created}" != "true" ]]; then
      exit 0
    fi
    if ! is_stable_tag "${tag_name}"; then
      echo "release-publish-postcondition: FAIL (stable tag ${tag_name} is not stable-shaped)" >&2
      exit 1
    fi
    echo "release-publish-postcondition: PASS (stable ${tag_name})"
    ;;
esac
