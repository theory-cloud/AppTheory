#!/usr/bin/env bash
set -euo pipefail

# Ensures `premain` stays aligned with the latest stable version on `main`.
#
# Why this exists:
# - `main` cuts stable releases using `.release-please-manifest.json`
# - `premain` cuts prereleases using `.release-please-manifest.premain.json`
# If `premain` doesn't regularly back-merge `main`, prereleases can get stuck on an old major/minor track.

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

base_ref="${GITHUB_BASE_REF:-}"
head_ref="${GITHUB_HEAD_REF:-}"
ref_name="${GITHUB_REF_NAME:-}"
branch="${base_ref:-${ref_name:-}}"
if [[ -z "${branch}" ]]; then
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
fi

mode="skip"
if [[ "${branch}" == "premain" ]]; then
  mode="premain"
elif [[ "${branch}" == "main" && "${head_ref}" == "premain" ]]; then
  mode="promotion"
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

premain_stable=""
premain_version=""

if [[ "${mode}" == "premain" ]]; then
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
else
  git_fetch_retry origin premain

  premain_stable="$(
    python3 - <<'PY'
import json
import subprocess

data = subprocess.check_output(
    ["git", "show", "origin/premain:.release-please-manifest.json"], text=True
)
print(json.loads(data).get(".", ""))
PY
  )"
  premain_version="$(
    python3 - <<'PY'
import json
import subprocess

data = subprocess.check_output(
    ["git", "show", "origin/premain:.release-please-manifest.premain.json"], text=True
)
print(json.loads(data).get(".", ""))
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
  echo "branch-version-sync: FAIL (premain .release-please-manifest.json ${premain_stable} != origin/main ${main_stable})"
  echo "branch-version-sync: hint: merge main into premain (back-merge after stable releases)"
  exit 1
fi

export MAIN_STABLE="${main_stable}"
export PREMAIN_VERSION="${premain_version}"

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
        f"(premain prerelease track {premain_version} is behind main {main_stable})"
    )
    print(
        "branch-version-sync: hint: reset .release-please-manifest.premain.json "
        "to the latest stable version after cutting a release on main"
    )
    sys.exit(1)
PY

echo "branch-version-sync: PASS (main=${main_stable}, premain=${premain_version})"

