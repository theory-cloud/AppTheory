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
    local output
    set +e
    output="$(
      GITHUB_BASE_REF=main \
      GITHUB_HEAD_REF=premain \
      GIT_FETCH_RETRIES=1 \
      GIT_FETCH_RETRY_SLEEP_SECS=0 \
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

  # Valid premain -> main PR merge content keeps main's stable manifest while
  # promoting premain's prerelease track. The live origin/premain stable
  # manifest is intentionally stale in this fixture; the gate must not read it
  # for main-promotion mode.
  write_manifests "1.13.0" "1.13.1-rc"
  run_self_test_case "main-promotion merge content" 0 "branch-version-sync: PASS"

  write_manifests "1.12.2" "1.13.1-rc"
  run_self_test_case "stale stable manifest rejected" 1 ".release-please-manifest.json 1.12.2 != origin/main 1.13.0"

  write_manifests "1.13.0" "1.12.2-rc"
  run_self_test_case "behind prerelease track rejected" 1 "prerelease track 1.12.2-rc is behind main 1.13.0"

  echo "branch-version-sync: self-test PASS"
  exit 0
fi

base_ref="${GITHUB_BASE_REF:-}"
head_ref="${GITHUB_HEAD_REF:-}"
ref_name="${GITHUB_REF_NAME:-}"
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
elif [[ "${branch}" == "main" && "${head_ref}" == "premain" ]]; then
  mode="main-promotion"
fi

if [[ "${mode}" == "skip" ]]; then
  echo "branch-version-sync: SKIP"
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
premain_stable=""
premain_version=""

if [[ "${mode}" == "premain" || "${mode}" == "staging-promotion" || "${mode}" == "staging" || "${mode}" == "main-promotion" ]]; then
  if [[ "${mode}" == "staging-promotion" ]]; then
    subject_label="staging->premain promotion"
  elif [[ "${mode}" == "staging" ]]; then
    subject_label="staging"
  elif [[ "${mode}" == "main-promotion" ]]; then
    subject_label="premain->main promotion"
  fi
  premain_stable="$(
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

if [[ -z "${premain_stable}" ]]; then
  echo "branch-version-sync: FAIL (missing premain stable manifest version)"
  exit 1
fi

if [[ -z "${premain_version}" ]]; then
  echo "branch-version-sync: FAIL (missing premain prerelease manifest version)"
  exit 1
fi

if [[ "${premain_stable}" != "${main_stable}" ]]; then
  echo "branch-version-sync: FAIL (${subject_label} .release-please-manifest.json ${premain_stable} != origin/main ${main_stable})"
  echo "branch-version-sync: hint: back-merge the released main head into staging before promoting staging to premain"
  exit 1
fi

export MAIN_STABLE="${main_stable}"
export PREMAIN_VERSION="${premain_version}"
export SUBJECT_LABEL="${subject_label}"

python3 - <<'PY'
import os
import sys

main_stable = os.environ["MAIN_STABLE"]
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
    premain_tuple = parse_base(premain_version)
except Exception as exc:
    print(f"branch-version-sync: FAIL ({exc})")
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

echo "branch-version-sync: PASS (main=${main_stable}, premain=${premain_version})"
