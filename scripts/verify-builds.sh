#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

epoch="${SOURCE_DATE_EPOCH:-}"
if [[ -z "${epoch}" ]]; then
  epoch="$(git show -s --format=%ct HEAD)"
fi

export SOURCE_DATE_EPOCH="${epoch}"

build_once() {
  local out_file="$1"
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  # Snapshot the repo contents deterministically from the working tree (tracked + non-ignored).
  #
  # Rationale: this verifier is used both in CI and locally. Using `git archive HEAD`
  # makes local verification misleading when changes are uncommitted, and it also
  # excludes new (but non-ignored) files. Using `git ls-files` keeps the snapshot
  # scoped to the repo surface area while still reflecting the current state.
  git ls-files -z --cached --others --exclude-standard \
    | tar --ignore-failed-read --null -T - -cf - \
    | tar -xf - -C "${tmp_dir}"

  (
    cd "${tmp_dir}"
    export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH}"
    make rubric >/dev/null
    scripts/generate-checksums.sh >/dev/null
    cat dist/SHA256SUMS.txt > "${out_file}"
  )

  rm -rf "${tmp_dir}"
}

tmp_a="$(mktemp)"
tmp_b="$(mktemp)"
trap 'rm -f "${tmp_a}" "${tmp_b}"' EXIT

build_once "${tmp_a}"
build_once "${tmp_b}"

if ! diff -u "${tmp_a}" "${tmp_b}" >/dev/null; then
  echo "verify-builds: FAIL (artifact checksums differ across builds)"
  diff -u "${tmp_a}" "${tmp_b}" || true
  exit 1
fi

echo "verify-builds: PASS (SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH})"
