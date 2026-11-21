#!/usr/bin/env bash
# Purpose: decide whether a release-channel push belongs to the generation phase
# (generate/update the Release Please PR) or the publication phase (the recorded
# merge of that generated PR).
#
# Invariant: a commit is publication-authoritative only when GitHub records it
# as the merge commit of a merged pull request whose base is this channel, whose
# head is the trusted `release-please--branches--<channel>` branch in this
# repository, and whose `merge_commit_sha` is exactly this commit. Any other
# channel update is generation phase: the release-PR producer owns it and the
# publisher must not publish or report a failed publish.
#
# The authority is GitHub's immutable commit-to-pull-request provenance. It is
# never a commit subject, a branch label, a bot identity, an expected label, or
# the future head of a mutable branch. A missing, malformed, or ambiguous
# provenance response fails closed.
#
# Usage:
#   scripts/classify-release-phase.sh --channel prerelease|stable \
#     [--head <sha>] [--repo <owner/name>] [--event-name push|workflow_dispatch] \
#     [--input <commits-pulls.json>]
#   scripts/classify-release-phase.sh --self-test
#
# Prints exactly `publish` or `generation` on stdout. Diagnostics go to stderr.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail() {
  echo "classify-release-phase: FAIL ($*)" >&2
  exit 1
}

self_test() {
  local tmp failures=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  head="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  other="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  repo="theory-cloud/AppTheory"

  cat >"${tmp}/release-merge.json" <<JSON
[
  {
    "number": 42,
    "state": "closed",
    "merged_at": "2026-11-20T19:34:53Z",
    "merge_commit_sha": "${head}",
    "base": {"ref": "premain", "repo": {"full_name": "${repo}"}},
    "head": {"ref": "release-please--branches--premain", "repo": {"full_name": "${repo}"}}
  }
]
JSON

  cat >"${tmp}/promotion.json" <<JSON
[
  {
    "number": 43,
    "state": "closed",
    "merged_at": "2026-11-21T19:27:46Z",
    "merge_commit_sha": "${head}",
    "base": {"ref": "premain", "repo": {"full_name": "${repo}"}},
    "head": {"ref": "staging", "repo": {"full_name": "${repo}"}}
  },
  {
    "number": 44,
    "state": "open",
    "merged_at": null,
    "merge_commit_sha": "${other}",
    "base": {"ref": "premain", "repo": {"full_name": "${repo}"}},
    "head": {"ref": "release-please--branches--premain", "repo": {"full_name": "${repo}"}}
  }
]
JSON

  cat >"${tmp}/lookalike.json" <<'JSON'
[]
JSON

  cat >"${tmp}/merged-sha-mismatch.json" <<JSON
[
  {
    "number": 45,
    "state": "closed",
    "merged_at": "2026-11-20T19:34:53Z",
    "merge_commit_sha": "${other}",
    "base": {"ref": "premain", "repo": {"full_name": "${repo}"}},
    "head": {"ref": "release-please--branches--premain", "repo": {"full_name": "${repo}"}}
  }
]
JSON

  cat >"${tmp}/fork-head.json" <<JSON
[
  {
    "number": 46,
    "state": "closed",
    "merged_at": "2026-11-20T19:34:53Z",
    "merge_commit_sha": "${head}",
    "base": {"ref": "premain", "repo": {"full_name": "${repo}"}},
    "head": {"ref": "release-please--branches--premain", "repo": {"full_name": "attacker/AppTheory"}}
  }
]
JSON

  cat >"${tmp}/ambiguous.json" <<JSON
[
  {
    "number": 47,
    "state": "closed",
    "merged_at": "2026-11-20T19:34:53Z",
    "merge_commit_sha": "${head}",
    "base": {"ref": "premain", "repo": {"full_name": "${repo}"}},
    "head": {"ref": "release-please--branches--premain", "repo": {"full_name": "${repo}"}}
  },
  {
    "number": 48,
    "state": "closed",
    "merged_at": "2026-11-20T19:35:53Z",
    "merge_commit_sha": "${head}",
    "base": {"ref": "premain", "repo": {"full_name": "${repo}"}},
    "head": {"ref": "release-please--branches--premain", "repo": {"full_name": "${repo}"}}
  }
]
JSON

  cat >"${tmp}/wrong-base.json" <<JSON
[
  {
    "number": 49,
    "state": "closed",
    "merged_at": "2026-11-20T19:34:53Z",
    "merge_commit_sha": "${head}",
    "base": {"ref": "main", "repo": {"full_name": "${repo}"}},
    "head": {"ref": "release-please--branches--premain", "repo": {"full_name": "${repo}"}}
  }
]
JSON

  cat >"${tmp}/malformed.json" <<'JSON'
{"message": "not a list"}
JSON

  expect() {
    local label="$1" expected_status="$2" expected_stdout="$3" expected_stderr="$4"
    shift 4
    local out err status
    set +e
    out="$("$@" 2>"${tmp}/stderr")"
    status=$?
    set -e
    err="$(cat "${tmp}/stderr")"
    if [[ "${status}" != "${expected_status}" ]]; then
      echo "classify-release-phase: self-test FAIL (${label}; expected exit ${expected_status}, got ${status})" >&2
      printf '%s\n' "${out}" "${err}" >&2
      failures=$((failures + 1))
      return
    fi
    if [[ -n "${expected_stdout}" && "${out}" != "${expected_stdout}" ]]; then
      echo "classify-release-phase: self-test FAIL (${label}; stdout ${out@Q} != ${expected_stdout@Q})" >&2
      printf '%s\n' "${err}" >&2
      failures=$((failures + 1))
      return
    fi
    if [[ -n "${expected_stderr}" && "${err}" != *"${expected_stderr}"* ]]; then
      echo "classify-release-phase: self-test FAIL (${label}; stderr missing ${expected_stderr@Q})" >&2
      printf '%s\n' "${out}" "${err}" >&2
      failures=$((failures + 1))
      return
    fi
    echo "classify-release-phase: self-test ${label} PASS"
  }

  classify() {
    # Explicit event name: the self-test must not inherit the runner's own
    # GITHUB_EVENT_NAME (CI runs it under pull_request, where a publisher phase
    # is not applicable). Callers that test another event append it last.
    bash scripts/classify-release-phase.sh \
      --channel prerelease --head "${head}" --repo "${repo}" --event-name push "$@"
  }

  expect "recorded-release-merge" 0 "publish" "recorded merge commit" \
    classify --input "${tmp}/release-merge.json"
  expect "ordinary-promotion" 0 "generation" "publication is not due" \
    classify --input "${tmp}/promotion.json"
  expect "lookalike-subject-without-provenance" 0 "generation" "publication is not due" \
    classify --input "${tmp}/lookalike.json"
  expect "merged-sha-mismatch" 1 "" "merge commit" \
    classify --input "${tmp}/merged-sha-mismatch.json"
  expect "untrusted-head-repository" 1 "" "trusted" \
    classify --input "${tmp}/fork-head.json"
  expect "ambiguous-provenance" 1 "" "ambiguous" \
    classify --input "${tmp}/ambiguous.json"
  expect "other-channel-base" 0 "generation" "publication is not due" \
    classify --input "${tmp}/wrong-base.json"
  expect "malformed-response" 1 "" "array" \
    classify --input "${tmp}/malformed.json"
  expect "dispatch-publication" 0 "publish" "recorded merge commit" \
    classify --event-name workflow_dispatch --input "${tmp}/release-merge.json"
  expect "dispatch-generation" 1 "" "publication/recovery" \
    classify --event-name workflow_dispatch --input "${tmp}/promotion.json"
  expect "unsupported-event" 1 "" "unsupported event" \
    classify --event-name pull_request --input "${tmp}/release-merge.json"

  mkdir -p "${tmp}/bin"
  printf '#!/usr/bin/env bash\nexit 1\n' >"${tmp}/bin/gh"
  chmod +x "${tmp}/bin/gh"
  expect "provenance-unavailable" 1 "" "could not read" \
    env PATH="${tmp}/bin:${PATH}" bash scripts/classify-release-phase.sh \
      --channel prerelease --head "${head}" --repo "${repo}" --event-name push

  if (( failures > 0 )); then
    echo "classify-release-phase: self-test FAIL (${failures} case(s))" >&2
    return 1
  fi
  echo "classify-release-phase: self-test PASS"
  return 0
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

channel=""
head="${GITHUB_SHA:-}"
repo="${GITHUB_REPOSITORY:-}"
event_name="${GITHUB_EVENT_NAME:-push}"
input=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)
      channel="${2:-}"
      shift 2
      ;;
    --head)
      head="${2:-}"
      shift 2
      ;;
    --repo)
      repo="${2:-}"
      shift 2
      ;;
    --event-name)
      event_name="${2:-}"
      shift 2
      ;;
    --input)
      input="${2:-}"
      shift 2
      ;;
    --help|-h)
      sed -n '3,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

case "${channel}" in
  prerelease)
    base_branch="premain"
    release_branch="release-please--branches--premain"
    ;;
  stable)
    base_branch="main"
    release_branch="release-please--branches--main"
    ;;
  *)
    fail "usage: $0 --channel prerelease|stable [--head <sha>] [--repo <owner/name>] [--event-name push|workflow_dispatch] [--input <json>]"
    ;;
esac

case "${event_name}" in
  push|workflow_dispatch) ;;
  *)
    fail "unsupported event ${event_name}; the publisher phase only applies to push and workflow_dispatch"
    ;;
esac

if [[ -z "${head}" ]]; then
  fail "head commit is unknown; pass --head or set GITHUB_SHA"
fi
if [[ ! "${head}" =~ ^[0-9a-fA-F]{40}$ ]]; then
  fail "head ${head} is not a full commit SHA"
fi
if [[ -z "${repo}" ]]; then
  repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)"
fi
if [[ -z "${repo}" ]]; then
  fail "repository is unknown; pass --repo or set GITHUB_REPOSITORY"
fi

if [[ -n "${input}" ]]; then
  if [[ ! -r "${input}" ]]; then
    fail "could not read provenance input ${input}"
  fi
  response="$(cat "${input}")"
else
  if ! command -v gh >/dev/null 2>&1; then
    fail "gh is required to read the commit-to-pull-request provenance"
  fi
  if ! response="$(
    gh api "repos/${repo}/commits/${head}/pulls?per_page=100" --header "Accept: application/vnd.github+json" 2>/dev/null
  )"; then
    fail "could not read pull request provenance for ${head} in ${repo}; rerun after the GitHub API is reachable"
  fi
fi

matcher="$(cat <<'PY'
import json
import sys

repo, head, base_branch, release_branch = sys.argv[1:5]
head_lower = head.lower()
repo_lower = repo.lower()

try:
    pulls = json.load(sys.stdin)
except json.JSONDecodeError as exc:
    raise SystemExit(f"classify-release-phase: FAIL (pull request provenance is not valid JSON: {exc})")

if not isinstance(pulls, list):
    raise SystemExit("classify-release-phase: FAIL (pull request provenance must be a JSON array)")

matches = []
mismatched_merge = []
untrusted = []
for pull in pulls:
    if not isinstance(pull, dict):
        raise SystemExit("classify-release-phase: FAIL (pull request provenance contains a non-object entry)")
    base = pull.get("base") or {}
    head_ref = pull.get("head") or {}
    if base.get("ref") != base_branch or head_ref.get("ref") != release_branch:
        continue
    if not pull.get("merged_at"):
        # An open or closed-unmerged generated release PR is not a publication.
        continue

    number = pull.get("number")
    merge_sha = pull.get("merge_commit_sha") or ""
    head_repo = ((head_ref.get("repo") or {}).get("full_name") or "").lower()
    base_repo = ((base.get("repo") or {}).get("full_name") or "").lower()

    if head_repo != repo_lower or base_repo != repo_lower:
        untrusted.append((number, head_repo or "<unknown>"))
        continue
    if not merge_sha or merge_sha.lower() != head_lower:
        mismatched_merge.append((number, merge_sha or "<missing>"))
        continue
    matches.append(number)

if len(matches) > 1:
    raise SystemExit(
        "classify-release-phase: FAIL (ambiguous provenance: "
        + ", ".join(f"PR #{number}" for number in matches)
        + f" all record merge commit {head}; refusing to choose a publication authority)"
    )
if mismatched_merge:
    details = ", ".join(f"PR #{number} -> {sha}" for number, sha in mismatched_merge)
    raise SystemExit(
        f"classify-release-phase: FAIL (generated release PR merge commit does not match head {head}: {details}; "
        "the publisher only accepts the recorded merge commit, never a rewritten or later head)"
    )
if untrusted:
    details = ", ".join(f"PR #{number} from {name}" for number, name in untrusted)
    raise SystemExit(
        f"classify-release-phase: FAIL (generated release PR head is not the trusted repository {repo}: {details})"
    )
if matches:
    print("publish")
    print(
        f"classify-release-phase: publish (head {head} is the recorded merge commit of "
        f"PR #{matches[0]} from {release_branch} into {base_branch})",
        file=sys.stderr,
    )
else:
    print("generation")
    print(
        f"classify-release-phase: generation (head {head} is not the recorded merge of "
        f"{release_branch} into {base_branch}; the generation lane owns this push and publication is not due)",
        file=sys.stderr,
    )
PY
)"

if ! phase="$(python3 -c "${matcher}" "${repo}" "${head}" "${base_branch}" "${release_branch}" <<<"${response}")"; then
  exit 1
fi

if [[ "${phase}" == "publish" ]]; then
  echo "publish"
  exit 0
fi

if [[ "${phase}" != "generation" ]]; then
  fail "provenance matcher returned an unknown phase ${phase@Q}"
fi

if [[ "${event_name}" == "workflow_dispatch" ]]; then
  fail "workflow_dispatch at ${head} is not the recorded merge of ${release_branch} into ${base_branch}; the publisher is a publication/recovery action, not a generation trigger. Merge the generated release PR and rerun that publisher run, or rerun the failed publisher run for its release-PR merge commit."
fi

echo "generation"
exit 0
