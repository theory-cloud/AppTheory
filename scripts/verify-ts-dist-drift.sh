#!/usr/bin/env bash
# Purpose: fail when TypeScript dist output differs from checked-in generated files.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "ts-dist-drift: BLOCKED (node not found)" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "ts-dist-drift: BLOCKED (npm not found)" >&2
  exit 1
fi
if [[ ! -d "ts" ]]; then
  echo "ts-dist-drift: FAIL (missing ts/)" >&2
  exit 1
fi
if [[ ! -d "ts/dist" ]]; then
  echo "ts-dist-drift: FAIL (missing checked-in ts/dist/)" >&2
  exit 1
fi
if [[ ! -f "ts/package-lock.json" ]]; then
  echo "ts-dist-drift: FAIL (missing ts/package-lock.json)" >&2
  exit 1
fi

list_expected_dist_files() {
  local src_dir="$1"
  find "${src_dir}" -type f -name '*.ts' | while IFS= read -r src_file; do
    local rel="${src_file#"${src_dir}/"}"
    local base="${rel%.ts}"
    printf '%s.d.ts\n' "${base}"
    printf '%s.d.ts.map\n' "${base}"
    printf '%s.js\n' "${base}"
    printf '%s.js.map\n' "${base}"
  done | sort
}

list_actual_dist_files() {
  local dist_dir="$1"
  find "${dist_dir}" -type f | while IFS= read -r dist_file; do
    printf '%s\n' "${dist_file#"${dist_dir}/"}"
  done | sort
}

self_test_tmp_root=""
self_test_probe_file=""

cleanup_self_test() {
  if [[ -n "${self_test_tmp_root}" ]]; then
    rm -rf "${self_test_tmp_root}"
  fi
  if [[ -n "${self_test_probe_file}" ]]; then
    rm -f "${self_test_probe_file}"
  fi
}

verify_dist_file_inventory() {
  local src_dir="$1"
  local dist_dir="$2"
  local expected
  local actual
  local diff_output
  expected="$(mktemp)"
  actual="$(mktemp)"

  list_expected_dist_files "${src_dir}" >"${expected}"
  list_actual_dist_files "${dist_dir}" >"${actual}"

  if ! diff_output="$(diff -u "${expected}" "${actual}")"; then
    echo "ts-dist-drift: FAIL (${dist_dir} file inventory does not match ${src_dir} outputs)" >&2
    echo "${diff_output}" >&2
    rm -f "${expected}" "${actual}"
    return 1
  fi

  rm -f "${expected}" "${actual}"
}

self_test() {
  self_test_tmp_root="$(mktemp -d)"
  self_test_probe_file="ts/dist/.apptheory-ts-dist-drift-self-test-$$.js"
  trap cleanup_self_test EXIT

  touch "${self_test_probe_file}"
  if [[ -z "$(git status --porcelain=v1 --untracked-files=all -- ts/dist)" ]]; then
    echo "ts-dist-drift: FAIL (self-test untracked ts/dist output was not detected)" >&2
    exit 1
  fi
  rm -f "${self_test_probe_file}"
  self_test_probe_file=""

  mkdir -p "${self_test_tmp_root}/src" "${self_test_tmp_root}/dist"
  : >"${self_test_tmp_root}/src/live.ts"
  : >"${self_test_tmp_root}/dist/live.d.ts"
  : >"${self_test_tmp_root}/dist/live.d.ts.map"
  : >"${self_test_tmp_root}/dist/live.js"
  : >"${self_test_tmp_root}/dist/live.js.map"
  : >"${self_test_tmp_root}/dist/stale.js"
  if verify_dist_file_inventory "${self_test_tmp_root}/src" "${self_test_tmp_root}/dist" >/dev/null 2>&1; then
    echo "ts-dist-drift: FAIL (self-test stale dist output was not detected)" >&2
    exit 1
  fi

  rm -f "${self_test_tmp_root}/dist/stale.js"
  verify_dist_file_inventory "${self_test_tmp_root}/src" "${self_test_tmp_root}/dist"

  cleanup_self_test
  trap - EXIT
  echo "ts-dist-drift: self-test PASS"
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit 0
elif [[ -n "${1:-}" ]]; then
  echo "ts-dist-drift: FAIL (unsupported argument ${1@Q})" >&2
  exit 1
fi

if [[ ! -d "ts/node_modules" ]]; then
  (cd ts && npm ci >/dev/null)
fi

(cd ts && npm run build >/dev/null)

if ! find ts/dist -name '*.js.map' -print -quit | grep -q .; then
  echo "ts-dist-drift: FAIL (missing JavaScript source maps in ts/dist)" >&2
  exit 1
fi
if ! find ts/dist -name '*.d.ts.map' -print -quit | grep -q .; then
  echo "ts-dist-drift: FAIL (missing declaration maps in ts/dist)" >&2
  exit 1
fi

verify_dist_file_inventory "ts/src" "ts/dist"

status_output="$(git status --porcelain=v1 --untracked-files=all -- ts/dist)"
if [[ -n "${status_output}" ]]; then
  echo "ts-dist-drift: FAIL (ts/dist has uncommitted generated drift after npm run build)" >&2
  echo "${status_output}" >&2
  exit 1
fi

echo "ts-dist-drift: PASS"
