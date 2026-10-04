#!/usr/bin/env bash
# Purpose: verify that a promotion range contains at least one release-eligible
# Conventional Commit (feat:/fix:/perf:), because release-please ships nothing
# else.
#
# This single predicate is shared by the two CI surfaces that must agree:
#   - "Prerelease readiness (staging → premain)" on the staging -> premain PR,
#     over origin/premain..origin/staging (the promotion range itself).
#   - "Release eligibility (staging → premain)" on PRs to staging and on pushes
#     to staging, over origin/premain..HEAD (the range that would exist after the
#     change lands, so a PR cannot be green while its promotion fails).
#
# Post-release main back-merge exemption (opt-in via --allow-main-backmerge):
# after a stable release the release train brings the released main branch back
# into staging. That range carries only `chore(main): release X.Y.Z` and
# `chore(release): sync generated release artifacts`, so it holds no
# release-driving commit -- correctly, because the release already shipped.
# TableTheory's staging-release-driver exempts exactly this shape
# (`if HEAD_REF == main -> PASS (post-release main back-merge)`); without the
# same exemption here every stable release leaves the merged staging SHA red.
#
# The exemption is deliberately narrow and only exists when the caller opts in:
#   - On a pull request the head ref must be exactly `main` and the head
#     repository must be this repository, so only the protected main branch -- and
#     never a fork's branch or a lookalike such as `main-hotfix` -- qualifies.
#     This mirrors the trusted-repository provenance rule in
#     scripts/verify-release-train-promotion.sh and the release train itself,
#     which only ever accepts `main -> staging` back-merges.
#   - On a push there is no pull-request head ref, so the pushed commit itself
#     must show the back-merge: a merge commit whose second parent is already
#     reachable from origin/main. A feature branch merged into staging carries
#     its own tip as that second parent, so it never qualifies, and neither does
#     a non-merge (squash-shaped) push.
# A chore-only feature PR, a lookalike or forked head ref, and a push that
# merges anything other than main all stay subject to the plain predicate.
#
# Exit codes: 0 PASS, 1 FAIL (range not release-eligible), 2 BLOCKED (invalid
# invocation, misconfigured exemption, or an unresolvable range).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

range=""
context=""
head_ref=""
head_repo=""
repository=""
allow_main_backmerge="false"
self_test="false"
backmerge_detail=""
# self_test_tmp is global so the EXIT trap can still see it after run_self_test
# has returned and its locals are gone.
self_test_tmp=""

usage() {
  cat <<'USAGE'
usage: scripts/verify-release-eligibility.sh --range <rev-range> --context <label>
       [--allow-main-backmerge --head-ref <pull-request-head-ref>
        --head-repo <pull-request-head-repository> --repository <owner/name>]
       [--self-test]

Fails closed unless the given git revision range contains at least one
release-eligible Conventional Commit subject: feat|fix|perf with an optional
scope and optional breaking-change marker.

--allow-main-backmerge opts in to the narrow post-release main back-merge
exemption, which only ever applies with --repository; the promotion range
itself never takes it. --self-test proves the exemption stays narrow.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --range)
      range="${2:-}"
      shift 2
      ;;
    --context)
      context="${2:-}"
      shift 2
      ;;
    --head-ref)
      head_ref="${2:-}"
      shift 2
      ;;
    --head-repo)
      head_repo="${2:-}"
      shift 2
      ;;
    --repository)
      repository="${2:-}"
      shift 2
      ;;
    --allow-main-backmerge)
      allow_main_backmerge="true"
      shift
      ;;
    --self-test)
      self_test="true"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "release-eligibility: FAIL (unknown argument: $1)" >&2
      exit 2
      ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  echo "release-eligibility: BLOCKED (git not found)" >&2
  exit 2
fi

# normalize_repository trims and lowercases an owner/name value, mirroring the
# trusted-repository comparison in scripts/verify-release-train-promotion.sh.
normalize_repository() {
  local value="${1:-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value,,}"
}

# is_post_release_main_backmerge returns 0 when HEAD is exactly the post-release
# back-merge of this repository's released main branch into staging, 1 when it is
# not, and 2 when the exemption cannot be evaluated without guessing.
is_post_release_main_backmerge() {
  backmerge_detail=""

  if [[ -n "${head_ref}" ]]; then
    # Pull-request leg. `main` is this repository's protected release branch and
    # the release train only ever writes released content there, so a pull
    # request whose head is this repository's `main` promotes nothing new. The
    # same-repository requirement is what keeps a fork's own branch named `main`
    # from taking the exemption.
    local normalized_head_repo normalized_repository
    normalized_head_repo="$(normalize_repository "${head_repo}")"
    normalized_repository="$(normalize_repository "${repository}")"
    if [[ "${head_ref}" == "main" ]] \
      && [[ -n "${normalized_head_repo}" ]] \
      && [[ "${normalized_head_repo}" == "${normalized_repository}" ]]; then
      backmerge_detail="pull-request head ${repository} main"
      return 0
    fi
    return 1
  fi

  # Push leg. A pull request has no head ref, so the pushed commit itself must
  # show the back-merge: a merge commit whose second parent already lives on
  # origin/main.
  if ! git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
    echo "release-eligibility: BLOCKED (origin/main is unavailable, so the post-release main back-merge exemption cannot be evaluated)" >&2
    return 2
  fi
  local second_parent=""
  second_parent="$(git rev-list --parents -n 1 HEAD 2>/dev/null | awk 'NF >= 3 { print $3; exit }')" || true
  if [[ -z "${second_parent}" ]]; then
    return 1
  fi
  if git merge-base --is-ancestor "${second_parent}" origin/main; then
    backmerge_detail="merge of origin/main into staging"
    return 0
  fi
  return 1
}

# eligibility_verdict prints the verdict and returns the exit code the default
# mode uses: 0 PASS, 1 FAIL, 2 BLOCKED.
eligibility_verdict() {
  echo "release-eligibility: checking commits in ${range} (${context})"

  # A range that git cannot resolve is a broken invocation or missing history,
  # not a release-eligibility verdict: block rather than pass.
  local commit_subjects=""
  if ! commit_subjects="$(git log --format=%s "${range}" 2>&1)"; then
    echo "release-eligibility: BLOCKED (cannot resolve ${range})" >&2
    printf '%s\n' "${commit_subjects}" >&2
    return 2
  fi

  if [[ "${allow_main_backmerge}" == "true" ]]; then
    # 0 = exempt, 1 = not the back-merge, 2 = exemption could not be evaluated.
    local exemption=0
    is_post_release_main_backmerge || exemption=$?
    if (( exemption == 0 )); then
      echo "release-eligibility: PASS (post-release main back-merge: ${backmerge_detail})"
      return 0
    fi
    if (( exemption == 2 )); then
      return 2
    fi
  fi

  # Do not pipe directly into grep -q under pipefail: grep exits as soon as it
  # finds a match, which can SIGPIPE git log and make a matching commit look like
  # a failed eligibility check.
  if grep -Eq '^(feat|fix|perf)(\([^)]+\))?(!)?: ' <<<"${commit_subjects}"; then
    echo "release-eligibility: PASS (${context})"
    return 0
  fi

  echo "release-eligibility: FAIL (${context})"
  echo "No user-facing conventional commits (feat:/fix:/perf:) found in ${range}."
  echo "release-please will skip, so no new release will be cut."
  echo
  echo "Commit subjects:"
  printf '%s\n' "${commit_subjects}" || true
  return 1
}

# run_self_test builds a throwaway release-train repository (released main, a
# premain RC line, staging after the back-merge) and proves the exemption stays
# narrow in both directions: every exempting shape passes, and chore-only,
# lookalike, forked, non-main-merge, and non-opted-in shapes still fail.
run_self_test() {
  self_test_tmp="$(mktemp -d)"
  trap 'rm -rf "${self_test_tmp}"' EXIT
  local fixture="${self_test_tmp}/repo"
  mkdir -p "${fixture}"
  cd "${fixture}"

  git init -q -b main .
  git config user.name "release-eligibility self-test"
  git config user.email "release-eligibility-self-test@example.invalid"
  git config commit.gpgsign false
  git config advice.detachedHead false

  # The predicate reads commit subjects and merge topology only, so a fixture
  # commit is a marker file whose content differs from its parent's. The tree
  # must differ from the parent's tree: `git log` drops TREESAME commits, and a
  # commit that changed nothing would vanish from the checked range.
  commit_on() { # <parent> <marker> <subject>
    local blob tree
    blob="$(printf '%s\n' "${2}" | git hash-object -w --stdin)"
    tree="$(printf '100644 blob %s\tmarker.txt\n' "${blob}" | git mktree)"
    git commit-tree "${tree}" -p "${1}" -m "${3}"
  }
  merge_of() { # <mainline-parent> <merged-parent> <marker> <subject>
    local blob tree
    blob="$(printf '%s\n' "${3}" | git hash-object -w --stdin)"
    tree="$(printf '100644 blob %s\tmarker.txt\n' "${blob}" | git mktree)"
    git commit-tree "${tree}" -p "${1}" -p "${2}" -m "${4}"
  }

  # The release train shape: a common base, the premain RC line, the stable
  # release promoted onto main from premain, and staging carrying the returned
  # back-merge of main. premain must not descend from main, or main's release
  # commits would sit outside the promotion range.
  git commit -q --allow-empty -m "chore: scaffold the release train"
  local base_sha premain_sha main_sha backmerge_sha
  base_sha="$(git rev-parse HEAD)"

  premain_sha="$(commit_on "${base_sha}" "premain-rc" "chore(premain): release 5.0.0-rc")"
  git update-ref refs/remotes/origin/premain "${premain_sha}"

  main_sha="$(commit_on "${premain_sha}" "main-release" "chore(main): release 5.0.0")"
  git update-ref refs/remotes/origin/main "${main_sha}"

  backmerge_sha="$(merge_of "${premain_sha}" "${main_sha}" "staging-backmerge" "Merge pull request #9999 from theory-cloud/main")"
  git update-ref refs/remotes/origin/staging "${backmerge_sha}"

  local chore_tip fix_tip lookalike_tip chore_merge fix_merge lookalike_merge
  chore_tip="$(commit_on "${backmerge_sha}" "chore-tip" "chore(docs): tidy the release notes")"
  chore_merge="$(merge_of "${backmerge_sha}" "${chore_tip}" "chore-merge" "Merge pull request #10000 from theory-cloud/chore-only")"
  fix_tip="$(commit_on "${backmerge_sha}" "fix-tip" "fix(runtime): repair the thing")"
  fix_merge="$(merge_of "${backmerge_sha}" "${fix_tip}" "fix-merge" "Merge pull request #10001 from theory-cloud/fix-runtime")"
  lookalike_tip="$(commit_on "${backmerge_sha}" "lookalike-tip" "chore(docs): lookalike notes")"
  lookalike_merge="$(merge_of "${backmerge_sha}" "${lookalike_tip}" "lookalike-merge" "Merge pull request #10002 from theory-cloud/main-hotfix")"

  local cases=0 failures=0
  check_case() { # <label> <expected-exit> <required-substring> <forbidden-substring>
    local label="$1" want="$2" required="${3:-}" forbidden="${4:-}"
    local status=0 output=""
    output="$(eligibility_verdict 2>&1)" || status=$?
    cases=$((cases + 1))
    if [[ "${status}" != "${want}" ]]; then
      echo "release-eligibility self-test: FAIL (${label}: expected exit ${want}, got ${status})" >&2
      printf '%s\n' "${output}" >&2
      failures=$((failures + 1))
      return 0
    fi
    if [[ -n "${required}" ]] && ! grep -Fq -- "${required}" <<<"${output}"; then
      echo "release-eligibility self-test: FAIL (${label}: verdict must mention ${required})" >&2
      printf '%s\n' "${output}" >&2
      failures=$((failures + 1))
      return 0
    fi
    if [[ -n "${forbidden}" ]] && grep -Fq -- "${forbidden}" <<<"${output}"; then
      echo "release-eligibility self-test: FAIL (${label}: verdict must not mention ${forbidden})" >&2
      printf '%s\n' "${output}" >&2
      failures=$((failures + 1))
      return 0
    fi
    echo "release-eligibility self-test: PASS (${label})"
    return 0
  }

  local backmerge_verdict="post-release main back-merge"
  range="origin/premain..HEAD"
  context="self-test"
  repository="theory-cloud/AppTheory"
  allow_main_backmerge="true"

  git switch -q --detach "${backmerge_sha}"
  head_ref=""
  head_repo=""
  check_case "push leg: the post-release back-merge of main is exempt" 0 "${backmerge_verdict}"

  head_ref="main"
  head_repo="theory-cloud/AppTheory"
  check_case "pull-request leg: head ref main from this repository is exempt" 0 "${backmerge_verdict}"

  head_repo="fork-owner/AppTheory"
  check_case "a fork head ref named main is not exempt" 1

  git switch -q --detach "${lookalike_merge}"
  head_ref="main-hotfix"
  head_repo="theory-cloud/AppTheory"
  check_case "a lookalike head ref named main-hotfix is not exempt" 1

  git switch -q --detach "${chore_merge}"
  head_ref="chore-only"
  check_case "a chore-only feature pull request still fails" 1

  git switch -q --detach "${fix_merge}"
  head_ref="fix/runtime"
  check_case "a normal fix pull request still passes" 0 "release-eligibility: PASS" "${backmerge_verdict}"

  git switch -q --detach "${chore_merge}"
  head_ref=""
  head_repo=""
  check_case "a push that merges a feature branch is not exempt" 1

  git switch -q --detach "${chore_tip}"
  check_case "a non-merge push is not exempt" 1

  git switch -q --detach "${backmerge_sha}"
  allow_main_backmerge="false"
  check_case "the back-merge range without the opt-in stays subject to the predicate" 1

  if (( failures > 0 )); then
    echo "release-eligibility self-test: FAIL (${failures} of ${cases} cases failed)" >&2
    return 1
  fi
  echo "release-eligibility self-test: PASS (${cases} cases)"
  return 0
}

if [[ "${self_test}" == "true" ]]; then
  if run_self_test; then
    exit 0
  fi
  exit 1
fi

if [[ -z "${range}" || -z "${context}" ]]; then
  echo "release-eligibility: FAIL (--range and --context are required)" >&2
  exit 2
fi

if [[ "${allow_main_backmerge}" == "true" && -z "$(normalize_repository "${repository}")" ]]; then
  echo "release-eligibility: FAIL (--allow-main-backmerge requires --repository in owner/name form)" >&2
  exit 2
fi

verdict=0
eligibility_verdict || verdict=$?
exit "${verdict}"
