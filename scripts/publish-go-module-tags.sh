#!/usr/bin/env bash
# Purpose: idempotently create AppTheory root and nested CDK Go tags without ever moving a ref.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=go-module-release-contract.sh
source "${repo_root}/scripts/go-module-release-contract.sh"
cd "${repo_root}"

preflight_remote_tag() {
  local remote="$1"
  local tag="$2"
  local source_commit="$3"
  local observed
  local status

  set +e
  observed="$(go_release_remote_tag_commit "${remote}" "${tag}")"
  status=$?
  set -e

  case "${status}" in
    0)
      if [[ "${observed}" != "${source_commit}" ]]; then
        echo \
          "go-module-tags: FAIL (${tag} already targets ${observed}; expected ${source_commit}; refs are immutable)" \
          >&2
        return 1
      fi
      ;;
    1) ;;
    *)
      return 1
      ;;
  esac
}

ensure_remote_tag() {
  local remote="$1"
  local tag="$2"
  local source_commit="$3"
  local observed
  local status

  set +e
  observed="$(go_release_remote_tag_commit "${remote}" "${tag}")"
  status=$?
  set -e

  case "${status}" in
    0)
      if [[ "${observed}" != "${source_commit}" ]]; then
        echo \
          "go-module-tags: FAIL (${tag} already targets ${observed}; expected ${source_commit}; refs are immutable)" \
          >&2
        return 1
      fi
      echo "go-module-tags: KEEP (${tag} already targets ${source_commit})"
      return 0
      ;;
    1) ;;
    *)
      return 1
      ;;
  esac

  if git push "${remote}" "${source_commit}:refs/tags/${tag}"; then
    echo "go-module-tags: CREATE (${tag} -> ${source_commit})"
  else
    # A concurrent publisher may have won the create-only race. Accept only
    # the exact same target; any other ref remains immutable and fails closed.
    set +e
    observed="$(go_release_remote_tag_commit "${remote}" "${tag}")"
    status=$?
    set -e
    if (( status != 0 )) || [[ "${observed}" != "${source_commit}" ]]; then
      echo \
        "go-module-tags: FAIL (${tag} could not be created at ${source_commit}; observed ${observed:-absent})" \
        >&2
      return 1
    fi
    echo "go-module-tags: KEEP (${tag} concurrently created at ${source_commit})"
  fi

  observed="$(go_release_remote_tag_commit "${remote}" "${tag}")" || return 1
  if [[ "${observed}" != "${source_commit}" ]]; then
    echo \
      "go-module-tags: FAIL (${tag} post-create target ${observed} != ${source_commit})" \
      >&2
    return 1
  fi
}

publish_tag_set() {
  local remote="$1"
  local tag="$2"
  local source_ref="$3"

  go_release_validate_source_contract "${tag}" "${source_ref}" || return 1

  # Detect any known conflict before creating either ref. The ensure step
  # repeats this check to stay fail-closed across concurrent publishers.
  preflight_remote_tag \
    "${remote}" \
    "${GO_RELEASE_ROOT_TAG}" \
    "${GO_RELEASE_SOURCE_COMMIT}" || return 1
  preflight_remote_tag \
    "${remote}" \
    "${GO_RELEASE_CDK_TAG}" \
    "${GO_RELEASE_SOURCE_COMMIT}" || return 1

  # Sequential create-only writes make partial failure safely retryable:
  # an existing same-SHA root tag is retained before the nested tag is retried.
  ensure_remote_tag \
    "${remote}" \
    "${GO_RELEASE_ROOT_TAG}" \
    "${GO_RELEASE_SOURCE_COMMIT}" || return 1
  ensure_remote_tag \
    "${remote}" \
    "${GO_RELEASE_CDK_TAG}" \
    "${GO_RELEASE_SOURCE_COMMIT}" || return 1

  echo \
    "go-module-tags: PASS (root=${GO_RELEASE_ROOT_TAG} cdk=${GO_RELEASE_CDK_TAG} source=${GO_RELEASE_SOURCE_COMMIT})"
}

commit_fixture_change() {
  local subject="$1"
  local path="$2"
  local contents="$3"

  mkdir -p "$(dirname "${path}")"
  printf '%s\n' "${contents}" >"${path}"
  git add "${path}"
  git \
    -c user.name="AppTheory Go Tag Self Test" \
    -c user.email="apptheory-go-tag-self-test@example.invalid" \
    commit -q -m "${subject}"
}

run_self_test() {
  local temporary
  local remote
  local work
  local source_commit
  local other_commit
  local output

  temporary="$(mktemp -d)"
  remote="${temporary}/remote.git"
  work="${temporary}/work"

  git init -q --bare "${remote}"
  git init -q "${work}"
  if ! (
    cd "${work}"
    git checkout -q -b main
    printf '%s\n' "2.0.0-rc" >VERSION
    printf '%s\n' \
      "module github.com/theory-cloud/apptheory/v2" \
      "" \
      "go 1.23" >go.mod
    mkdir -p cdk-go/apptheorycdk
    printf '%s\n' \
      "module github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v2" \
      "" \
      "go 1.23" >cdk-go/apptheorycdk/go.mod
    printf '%s\n' "package apptheory" >apptheory.go
    printf '%s\n' "package apptheorycdk" >cdk-go/apptheorycdk/apptheorycdk.go
    git add VERSION go.mod apptheory.go cdk-go/apptheorycdk
    git \
      -c user.name="AppTheory Go Tag Self Test" \
      -c user.email="apptheory-go-tag-self-test@example.invalid" \
      commit -q -m "chore: seed v2 release"
    source_commit="$(git rev-parse HEAD)"

    commit_fixture_change "chore: create conflicting target" "other.txt" "other"
    other_commit="$(git rev-parse HEAD)"
    git remote add origin "${remote}"
    git push -q origin HEAD:refs/heads/main

    publish_tag_set origin "v2.0.0-rc" "${source_commit}" >/dev/null
    [[ "$(git --git-dir="${remote}" rev-parse refs/tags/v2.0.0-rc)" == "${source_commit}" ]]
    [[ "$(
      git --git-dir="${remote}" rev-parse refs/tags/cdk-go/apptheorycdk/v2.0.0-rc
    )" == "${source_commit}" ]]
    echo "go-module-tags self-test: PASS absent refs are created"

    output="$(publish_tag_set origin "v2.0.0-rc" "${source_commit}")"
    grep -Fq "KEEP (v2.0.0-rc already targets ${source_commit})" <<<"${output}"
    grep -Fq \
      "KEEP (cdk-go/apptheorycdk/v2.0.0-rc already targets ${source_commit})" \
      <<<"${output}"
    echo "go-module-tags self-test: PASS same-SHA refs are idempotent"

    git --git-dir="${remote}" update-ref -d \
      refs/tags/cdk-go/apptheorycdk/v2.0.0-rc
    output="$(publish_tag_set origin "v2.0.0-rc" "${source_commit}")"
    grep -Fq "KEEP (v2.0.0-rc already targets ${source_commit})" <<<"${output}"
    grep -Fq \
      "CREATE (cdk-go/apptheorycdk/v2.0.0-rc -> ${source_commit})" \
      <<<"${output}"
    [[ "$(git --git-dir="${remote}" rev-parse refs/tags/v2.0.0-rc)" == "${source_commit}" ]]
    [[ "$(
      git --git-dir="${remote}" rev-parse refs/tags/cdk-go/apptheorycdk/v2.0.0-rc
    )" == "${source_commit}" ]]
    echo "go-module-tags self-test: PASS partial root-only state is repaired create-only"

    git --git-dir="${remote}" update-ref \
      refs/tags/cdk-go/apptheorycdk/v2.0.0-rc \
      "${other_commit}"
    git --git-dir="${remote}" update-ref -d refs/tags/v2.0.0-rc
    if output="$(publish_tag_set origin "v2.0.0-rc" "${source_commit}" 2>&1)"; then
      echo "go-module-tags self-test: FAIL (conflicting nested tag was accepted)" >&2
      exit 1
    fi
    grep -Fq "refs are immutable" <<<"${output}"
    if git --git-dir="${remote}" show-ref --verify --quiet refs/tags/v2.0.0-rc; then
      echo "go-module-tags self-test: FAIL (root tag was created after a known nested conflict)" >&2
      exit 1
    fi
    [[ "$(
      git --git-dir="${remote}" rev-parse refs/tags/cdk-go/apptheorycdk/v2.0.0-rc
    )" == "${other_commit}" ]]
    echo "go-module-tags self-test: PASS known nested conflict fails before either ref mutates"

    git --git-dir="${remote}" update-ref \
      refs/tags/cdk-go/apptheorycdk/v2.0.0-rc \
      "${source_commit}"
    git --git-dir="${remote}" update-ref refs/tags/v2.0.0-rc "${other_commit}"
    if output="$(publish_tag_set origin "v2.0.0-rc" "${source_commit}" 2>&1)"; then
      echo "go-module-tags self-test: FAIL (conflicting root tag was accepted)" >&2
      exit 1
    fi
    grep -Fq "refs are immutable" <<<"${output}"
    [[ "$(git --git-dir="${remote}" rev-parse refs/tags/v2.0.0-rc)" == "${other_commit}" ]]
    echo "go-module-tags self-test: PASS conflicting root ref fails without mutation"
  ); then
    rm -rf "${temporary}"
    return 1
  fi

  rm -rf "${temporary}"
  echo "go-module-tags self-test: PASS"
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
  exit 0
fi

tag="${1:-}"
source_ref="${2:-}"
if [[ -z "${tag}" || -z "${source_ref}" || $# -ne 2 ]]; then
  echo "go-module-tags: FAIL (usage: $0 <vX.Y.Z[-rc[.N]]> <source-commit>)" >&2
  exit 1
fi

publish_tag_set "${GIT_REMOTE:-origin}" "${tag}" "${source_ref}"
