#!/usr/bin/env bash
# Purpose: verify branch/version manifest state is synchronized across release lanes.
set -euo pipefail

# Ensures `premain` stays aligned with the latest stable version on `main`.
#
# Why this exists:
# - `main` cuts stable releases using `.release-please-manifest.json`
# - `premain` cuts prereleases using `.release-please-manifest.premain.json`
# - after a stable cut, the released `main` head must be promoted back into `staging`
# - `premain` receives that baseline only through `staging` -> `premain` promotions
# If `staging` or `premain` drift from the latest stable baseline on `main`,
# prereleases can get stuck on an old major/minor track.
#
# Pull requests are validated from the checked-out content. In particular, a
# premain -> main PR is checked as the PR merge content, not by re-reading the
# live origin/premain tip. The merge content is where the current main stable
# manifest is preserved while the premain prerelease track is promoted; the
# subsequent main -> staging -> premain edges reset the protected premain tip.
#
# The lane is chosen from the pull request's base and head refs. GitHub sets
# GITHUB_BASE_REF and GITHUB_HEAD_REF only for pull_request and
# pull_request_target runs, so the code-owner review that satisfies the
# premain/main ruleset (a pull_request_review run) supplies the same refs as
# PR_BASE_REF/PR_HEAD_REF from the event's pull_request object. On such a run
# GITHUB_REF_NAME is `<pr_number>/merge`, which is not a release lane: a review
# run that cannot derive its pull request fails instead of skipping, so the
# required context never passes without validating.

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # `scripts/verify-builds.sh` runs rubric in git-less working copies; this verifier needs git metadata.
  echo "branch-version-sync: SKIP (not a git repository)"
  exit 0
fi

git_fetch_retry() {
  local remote="$1"
  shift

  local -a refspecs=("$@")
  local attempts="${GIT_FETCH_RETRIES:-5}"
  local base_sleep="${GIT_FETCH_RETRY_SLEEP_SECS:-2}"

  local i=1
  while true; do
    if git fetch --quiet --depth=1 "${remote}" "${refspecs[@]}"; then
      return 0
    fi

    if [[ "${i}" -ge "${attempts}" ]]; then
      echo "branch-version-sync: FAIL (git fetch failed after ${attempts} attempts)" >&2
      return 1
    fi

    sleep_for=$((base_sleep * i))
    echo "branch-version-sync: retrying git fetch in ${sleep_for}s (${i}/${attempts})..." >&2
    sleep "${sleep_for}"
    i=$((i + 1))
  done
}

if [[ "${1:-}" == "--self-test" ]]; then
  script_path="${BASH_SOURCE[0]}"
  tmp_dir="$(mktemp -d)"
  cleanup() {
    rm -rf "${tmp_dir}"
  }
  trap cleanup EXIT

  mkdir -p "${tmp_dir}/repo/scripts"
  cp "${script_path}" "${tmp_dir}/repo/scripts/verify-branch-version-sync.sh"

  cd "${tmp_dir}/repo"
  git init --quiet --initial-branch=main
  git config user.email "apptheory-branch-version-sync@example.invalid"
  git config user.name "AppTheory Branch Version Sync Self Test"

  write_manifests() {
    local stable="$1"
    local premain="$2"
    printf '{\n  ".": "%s"\n}\n' "${stable}" >.release-please-manifest.json
    printf '{\n  ".": "%s"\n}\n' "${premain}" >.release-please-manifest.premain.json
  }

  commit_manifests() {
    local message="$1"
    git add .release-please-manifest.json .release-please-manifest.premain.json
    git commit --quiet -m "${message}"
  }

  write_manifests "1.13.0" "1.13.0"
  commit_manifests "main stable baseline"

  remote_path="${tmp_dir}/origin.git"
  git init --quiet --bare "${remote_path}"
  git remote add origin "${remote_path}"
  git push --quiet origin main

  git switch --quiet -c premain
  write_manifests "1.12.2" "1.13.1-rc"
  commit_manifests "stale premain stable manifest"
  git push --quiet origin premain

  git switch --quiet main

  run_self_test_case() {
    local label="$1"
    local expected_exit="$2"
    local expected_output="$3"
    shift 3
    local output
    set +e
    # Every case starts from the event variables GitHub provides, unset: the
    # caller then says exactly which ones its event sets. A case that inherits
    # the runner's own event would not prove the derivation.
    output="$(
      env -u GITHUB_BASE_REF -u GITHUB_HEAD_REF -u GITHUB_REF -u GITHUB_REF_NAME \
        -u GITHUB_SHA -u GITHUB_EVENT_NAME -u GITHUB_EVENT_PATH \
        -u PR_BASE_REF -u PR_HEAD_REF \
        GIT_FETCH_RETRIES=1 \
        GIT_FETCH_RETRY_SLEEP_SECS=0 \
        "$@" \
        bash scripts/verify-branch-version-sync.sh 2>&1
    )"
    local status=$?
    set -e
    if [[ "${status}" != "${expected_exit}" ]]; then
      echo "branch-version-sync: self-test FAIL (${label}; expected exit ${expected_exit}, got ${status})"
      echo "${output}"
      exit 1
    fi
    if [[ "${output}" != *"${expected_output}"* ]]; then
      echo "branch-version-sync: self-test FAIL (${label}; missing ${expected_output@Q})"
      echo "${output}"
      exit 1
    fi
    echo "branch-version-sync: self-test ${label} PASS"
  }

  pull_request_event=(
    GITHUB_EVENT_NAME=pull_request
    GITHUB_BASE_REF=main
    GITHUB_HEAD_REF=premain
    GITHUB_REF_NAME=main
    GITHUB_REF=refs/heads/main
  )

  # Valid premain -> main PR merge content keeps main's stable manifest while
  # promoting premain's prerelease track. The live origin/premain stable
  # manifest is intentionally stale in this fixture; the gate must not read it
  # for main-promotion mode.
  write_manifests "1.13.0" "1.13.1-rc"
  run_self_test_case "main-promotion merge content" 0 "branch-version-sync: PASS (mode=main-promotion" \
    "${pull_request_event[@]}"

  write_manifests "1.12.2" "1.13.1-rc"
  run_self_test_case "stale stable manifest rejected" 1 ".release-please-manifest.json 1.12.2 != origin/main 1.13.0" \
    "${pull_request_event[@]}"

  write_manifests "1.13.0" "1.12.2-rc"
  run_self_test_case "behind prerelease track rejected" 1 "prerelease track 1.12.2-rc is behind main 1.13.0" \
    "${pull_request_event[@]}"

  # A pull_request event without its refs is not a reason to skip: the review
  # event that satisfies the ruleset is the one that loses these variables.
  run_self_test_case "pull_request without refs rejected" 1 \
    "pull_request event carries no pull request base/head ref" \
    GITHUB_EVENT_NAME=pull_request

  # The code-owner review supplies the same refs the workflow step passes from
  # the event's pull_request object, and GITHUB_REF_NAME is `<n>/merge`.
  review_env() {
    local base="$1"
    local head="$2"
    printf '%s\n' \
      GITHUB_EVENT_NAME=pull_request_review \
      GITHUB_REF_NAME=1302/merge \
      "GITHUB_REF=refs/pull/1302/merge" \
      "PR_BASE_REF=${base}" \
      "PR_HEAD_REF=${head}"
  }

  write_manifests "1.13.0" "1.13.1-rc"
  mapfile -t review_bytes < <(review_env premain staging)
  run_self_test_case "review into premain validates the staging promotion" 0 \
    "branch-version-sync: PASS (mode=staging-promotion" \
    "${review_bytes[@]}"

  mapfile -t review_bytes < <(review_env main premain)
  run_self_test_case "review into main validates the premain promotion" 0 \
    "branch-version-sync: PASS (mode=main-promotion" \
    "${review_bytes[@]}"

  write_manifests "1.13.0" "1.13.1-rc"
  mapfile -t review_bytes < <(review_env premain release-please--branches--premain)
  run_self_test_case "review of the generated premain release PR validates the prerelease track" 0 \
    "branch-version-sync: PASS (mode=premain" \
    "${review_bytes[@]}"

  write_manifests "1.14.0" "1.14.0"
  mapfile -t review_bytes < <(review_env main release-please--branches--main)
  run_self_test_case "review of the generated main release PR validates the cut" 0 \
    "branch-version-sync: PASS (mode=stable-release" \
    "${review_bytes[@]}"

  write_manifests "1.14.0" "1.13.5-rc"
  mapfile -t review_bytes < <(review_env main release-please--branches--main)
  run_self_test_case "stable release behind its premain baseline rejected" 1 \
    "premain prerelease track 1.13.5-rc is behind the stable release 1.14.0 being cut" \
    "${review_bytes[@]}"

  write_manifests "1.12.0" "1.12.0"
  mapfile -t review_bytes < <(review_env main release-please--branches--main)
  run_self_test_case "stable release moving main backwards rejected" 1 \
    ".release-please-manifest.json 1.12.0 is behind origin/main 1.13.0" \
    "${review_bytes[@]}"

  write_manifests "1.13.0" "1.13.1-rc"
  mapfile -t review_bytes < <(review_env main some-feature)
  run_self_test_case "review into main with an unmodelled head rejected" 1 \
    "pull request into main carries unmodelled head some-feature" \
    "${review_bytes[@]}"

  # The payload is the second review-event source: a caller that only has the
  # event file must derive the same refs.
  payload_file="${tmp_dir}/review-payload.json"
  cat >"${payload_file}" <<'JSON'
{
  "action": "submitted",
  "pull_request": {
    "base": {"ref": "premain"},
    "head": {"ref": "staging"}
  }
}
JSON
  write_manifests "1.13.0" "1.13.1-rc"
  run_self_test_case "review payload alone derives the promotion" 0 \
    "branch-version-sync: PASS (mode=staging-promotion" \
    GITHUB_EVENT_NAME=pull_request_review \
    "GITHUB_EVENT_PATH=${payload_file}" \
    GITHUB_REF_NAME=1302/merge

  # A review event with neither source is a failure, not a silent skip.
  run_self_test_case "review without refs fails" 1 \
    "pull_request_review event carries no pull request base/head ref" \
    GITHUB_EVENT_NAME=pull_request_review \
    GITHUB_REF_NAME=1302/merge \
    "GITHUB_REF=refs/pull/1302/merge"

  # A push keeps its own derivation: the branch name is the ref, and a
  # non-release branch still skips rather than failing.
  run_self_test_case "push to a non-release branch skips" 0 "branch-version-sync: SKIP" \
    GITHUB_EVENT_NAME=push \
    GITHUB_REF_NAME=feature/example \
    "GITHUB_REF=refs/heads/feature/example"

  echo "branch-version-sync: self-test PASS"
  exit 0
fi

event_name="${GITHUB_EVENT_NAME:-}"
base_ref="${PR_BASE_REF:-${GITHUB_BASE_REF:-}}"
head_ref="${PR_HEAD_REF:-${GITHUB_HEAD_REF:-}}"
ref_name="${GITHUB_REF_NAME:-}"

pull_request_event=false
case "${event_name}" in
  pull_request | pull_request_review) pull_request_event=true ;;
esac

if [[ "${pull_request_event}" == "true" && ( -z "${base_ref}" || -z "${head_ref}" ) ]]; then
  # The workflow step passes the refs; the payload is the fallback for a caller
  # that only has GITHUB_EVENT_PATH. Either source is the reviewed pull request.
  payload_refs=""
  if [[ -n "${GITHUB_EVENT_PATH:-}" && -f "${GITHUB_EVENT_PATH:-}" ]]; then
    payload_refs="$(
      python3 - "${GITHUB_EVENT_PATH}" <<'PY'
import json
import sys
from pathlib import Path

try:
    event = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    event = {}
pull_request = event.get("pull_request")
if not isinstance(pull_request, dict):
    pull_request = {}
for name in ("base", "head"):
    side = pull_request.get(name)
    ref = side.get("ref") if isinstance(side, dict) else ""
    print(f"{name}={ref if isinstance(ref, str) else ''}")
PY
    )"
  fi
  if [[ -z "${base_ref}" ]]; then
    base_ref="$(sed -n 's/^base=//p' <<<"${payload_refs}")"
  fi
  if [[ -z "${head_ref}" ]]; then
    head_ref="$(sed -n 's/^head=//p' <<<"${payload_refs}")"
  fi
fi

if [[ "${pull_request_event}" == "true" && ( -z "${base_ref}" || -z "${head_ref}" ) ]]; then
  echo "branch-version-sync: FAIL (${event_name} event carries no pull request base/head ref; cannot choose a release lane)"
  exit 1
fi

branch="${base_ref:-${ref_name:-}}"
if [[ -z "${branch}" ]]; then
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
fi

mode="skip"
if [[ "${branch}" == "premain" ]]; then
  if [[ "${head_ref}" == "staging" ]]; then
    # Staging -> premain is the only supported path to refresh premain, so
    # validate the promoted content itself (the checked-out PR merge/head),
    # not the current remote premain branch.
    mode="staging-promotion"
  else
    mode="premain"
  fi
elif [[ "${branch}" == "staging" ]]; then
  # Staging is where stale prerelease state must be repaired before the next
  # staging -> premain promotion. Validate the checked-out staging PR/head so a
  # stale .release-please-manifest.premain.json cannot reach premain.
  mode="staging"
elif [[ "${branch}" == "main" ]]; then
  if [[ "${head_ref}" == "premain" ]]; then
    mode="main-promotion"
  elif [[ "${head_ref}" == "release-please--branches--main" ]]; then
    # The generated stable release pull request advances main's stable manifest
    # to the version it is cutting. It must not move main backwards, and the
    # premain prerelease track it promotes must not lag the release being cut.
    mode="stable-release"
  elif [[ "${pull_request_event}" == "true" ]]; then
    # Every pull request into main carries premain or the generated release
    # branch; an unmodelled head is an error, not a reason to pass unseen.
    echo "branch-version-sync: FAIL (pull request into main carries unmodelled head ${head_ref:-unknown})"
    exit 1
  fi
fi

if [[ "${mode}" == "skip" ]]; then
  echo "branch-version-sync: SKIP (${branch:-no branch} is not a release lane)"
  exit 0
fi

for f in ".release-please-manifest.json" ".release-please-manifest.premain.json"; do
  if [[ ! -f "${f}" ]]; then
    echo "branch-version-sync: FAIL (missing ${f})"
    exit 1
  fi
done

git_fetch_retry origin main

main_stable="$(
  python3 - <<'PY'
import json
import subprocess

data = subprocess.check_output(
    ["git", "show", "origin/main:.release-please-manifest.json"], text=True
)
print(json.loads(data).get(".", ""))
PY
)"

if [[ -z "${main_stable}" ]]; then
  echo "branch-version-sync: FAIL (could not read origin/main stable version)"
  exit 1
fi

subject_label="premain"
tree_stable=""
premain_version=""

if [[ "${mode}" == "premain" || "${mode}" == "staging-promotion" || "${mode}" == "staging" || "${mode}" == "main-promotion" || "${mode}" == "stable-release" ]]; then
  if [[ "${mode}" == "staging-promotion" ]]; then
    subject_label="staging->premain promotion"
  elif [[ "${mode}" == "staging" ]]; then
    subject_label="staging"
  elif [[ "${mode}" == "main-promotion" ]]; then
    subject_label="premain->main promotion"
  elif [[ "${mode}" == "stable-release" ]]; then
    subject_label="release-please stable release"
  fi
  tree_stable="$(
    python3 - <<'PY'
import json
from pathlib import Path

data = json.loads(Path(".release-please-manifest.json").read_text(encoding="utf-8"))
print(data.get(".", ""))
PY
  )"
  premain_version="$(
    python3 - <<'PY'
import json
from pathlib import Path

data = json.loads(
    Path(".release-please-manifest.premain.json").read_text(encoding="utf-8")
)
print(data.get(".", ""))
PY
  )"
fi

if [[ -z "${tree_stable}" ]]; then
  echo "branch-version-sync: FAIL (missing stable manifest version)"
  exit 1
fi

if [[ -z "${premain_version}" ]]; then
  echo "branch-version-sync: FAIL (missing premain prerelease manifest version)"
  exit 1
fi

export MODE="${mode}"
export MAIN_STABLE="${main_stable}"
export TREE_STABLE="${tree_stable}"
export PREMAIN_VERSION="${premain_version}"
export SUBJECT_LABEL="${subject_label}"

python3 - <<'PY'
import os
import sys

mode = os.environ["MODE"]
main_stable = os.environ["MAIN_STABLE"]
tree_stable = os.environ["TREE_STABLE"]
premain_version = os.environ["PREMAIN_VERSION"]


def parse_base(v: str) -> tuple[int, int, int]:
    v = v.strip()
    if v.startswith("v"):
        v = v[1:]
    v = v.split("+", 1)[0]
    base = v.split("-", 1)[0]
    parts = base.split(".")
    if len(parts) != 3:
        raise ValueError(f"invalid semver base: {v}")
    return (int(parts[0]), int(parts[1]), int(parts[2]))


try:
    main_tuple = parse_base(main_stable)
    tree_stable_tuple = parse_base(tree_stable)
    premain_tuple = parse_base(premain_version)
except Exception as exc:
    print(f"branch-version-sync: FAIL ({exc})")
    sys.exit(1)

if mode == "stable-release":
    # The generated stable release pull request advances main's stable manifest
    # to the version it cuts, so the checked-out manifest is legitimately ahead
    # of origin/main. It must not move backwards, and the premain prerelease
    # track it promotes must reach that release.
    if tree_stable_tuple < main_tuple:
        print(
            "branch-version-sync: FAIL "
            f"({os.environ['SUBJECT_LABEL']} .release-please-manifest.json {tree_stable} is behind origin/main {main_stable})"
        )
        print("branch-version-sync: hint: the release pull request must not move main's stable manifest backwards")
        sys.exit(1)
    if premain_tuple < tree_stable_tuple:
        print(
            "branch-version-sync: FAIL "
            f"({os.environ['SUBJECT_LABEL']} premain prerelease track {premain_version} is behind the stable release {tree_stable} being cut)"
        )
        print("branch-version-sync: hint: promote the premain RC baseline into main before cutting the stable release")
        sys.exit(1)
    sys.exit(0)

if tree_stable != main_stable:
    print(
        "branch-version-sync: FAIL "
        f"({os.environ['SUBJECT_LABEL']} .release-please-manifest.json {tree_stable} != origin/main {main_stable})"
    )
    print("branch-version-sync: hint: back-merge the released main head into staging before promoting staging to premain")
    sys.exit(1)

if premain_tuple < main_tuple:
    print(
        "branch-version-sync: FAIL "
        f"({os.environ['SUBJECT_LABEL']} prerelease track {premain_version} is behind main {main_stable})"
    )
    print(
        "branch-version-sync: hint: reset .release-please-manifest.premain.json "
        "on staging to the latest stable version after cutting a release on main"
    )
    sys.exit(1)
PY

echo "branch-version-sync: PASS (mode=${mode}, ${subject_label}; main=${main_stable}, stable=${tree_stable}, premain=${premain_version})"
