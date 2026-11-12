#!/usr/bin/env bash
# Purpose: verify release artifact builds are deterministic and complete.
#
# This gate owns the build/package surface only. The lint, test, contract, CDK
# construct and CDK synth checks live in the full rubric and in their dedicated
# CI jobs; running them again inside every build pass duplicated the whole
# product suite without strengthening the determinism claim.
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
  local log_file
  tmp_dir="$(mktemp -d)"
  log_file="${tmp_dir}/build.log"

  # Fail the current pass with the failing command's own exit code and a log tail.
  fail_build() {
    local cmd="$1"
    local ec="$2"
    echo "verify-builds: FAIL (${cmd} exited ${ec}; tail of build log follows, full log: ${log_file})" >&2
    tail -n 120 "${log_file}" >&2 || true
    exit "${ec}"
  }

  # Snapshot the repo contents deterministically from the working tree (tracked + non-ignored).
  #
  # Rationale: this verifier is used both in CI and locally. Using `git archive HEAD`
  # makes local verification misleading when changes are uncommitted, and it also
  # excludes new (but non-ignored) files. Using `git ls-files` keeps the snapshot
  # scoped to the repo surface area while still reflecting the current state.
  # GNU tar is selected when present because CI requires its --ignore-failed-read;
  # a BSD tar host keeps the same snapshot without the GNU-only flag.
  local tar_bin
  local -a tar_flags=()
  tar_bin="$(command -v gtar || command -v tar)"
  if "${tar_bin}" --ignore-failed-read -cf /dev/null /dev/null >/dev/null 2>&1; then
    tar_flags=(--ignore-failed-read)
  fi
  git ls-files -z --cached --others --exclude-standard \
    | python3 -c 'import sys
data = sys.stdin.buffer.read().split(b"\0")
sys.stdout.buffer.write(b"\0".join(p for p in data if p and p != b"gov-infra/evidence/gov-rubric-report.json") + b"\0")' \
    | "${tar_bin}" "${tar_flags[@]}" --null -T - -cf - \
    | "${tar_bin}" -xf - -C "${tmp_dir}"

  (
    cd "${tmp_dir}"
    export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH}"
    # Guard each inner command individually: a subshell on the left of `||` disables
    # errexit for everything inside it, so a single `( ... ) || fail` wrapper would
    # let a post-build gate failure slide through as a silent PASS.
    scripts/verify-ts-dist-drift.sh > "${log_file}" 2>&1 || fail_build "verify-ts-dist-drift.sh" "$?"
    scripts/verify-ts-pack.sh >> "${log_file}" 2>&1 || fail_build "verify-ts-pack.sh" "$?"
    scripts/verify-python-build.sh >> "${log_file}" 2>&1 || fail_build "verify-python-build.sh" "$?"
    scripts/verify-cdk-ts-pack.sh >> "${log_file}" 2>&1 || fail_build "verify-cdk-ts-pack.sh" "$?"
    scripts/verify-cdk-python-build.sh >> "${log_file}" 2>&1 || fail_build "verify-cdk-python-build.sh" "$?"
    scripts/generate-checksums.sh >> "${log_file}" 2>&1 || fail_build "generate-checksums.sh" "$?"
    cat dist/SHA256SUMS.txt > "${out_file}" || fail_build "checksums cat" "$?"
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

echo "verify-builds: PASS (SOURCE_DATE_EPOCH=${epoch})"
