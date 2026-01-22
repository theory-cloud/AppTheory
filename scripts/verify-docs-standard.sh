#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

required_dirs=(
  "docs"
  "ts/docs"
  "py/docs"
  "cdk/docs"
)

required_files=(
  "README.md"
  "_concepts.yaml"
  "_patterns.yaml"
  "_decisions.yaml"
  "getting-started.md"
  "api-reference.md"
  "core-patterns.md"
  "development-guidelines.md"
  "testing-guide.md"
  "troubleshooting.md"
  "migration-guide.md"
)

fail=0

echo "docs-standard: verifying Pay Theory documentation layout"

for d in "${required_dirs[@]}"; do
  if [[ ! -d "${d}" ]]; then
    echo "FAIL: missing docs directory: ${d}" >&2
    fail=1
    continue
  fi

  for f in "${required_files[@]}"; do
    p="${d}/${f}"
    if [[ ! -f "${p}" ]]; then
      echo "FAIL: missing required doc file: ${p}" >&2
      fail=1
    fi
  done

  readme="${d}/README.md"
  if [[ -f "${readme}" ]]; then
    if ! grep -q '<!-- AI Training:' "${readme}"; then
      echo "FAIL: missing AI training signal in ${readme}" >&2
      fail=1
    fi
    if ! grep -q 'OFFICIAL documentation' "${readme}"; then
      echo "FAIL: missing OFFICIAL statement in ${readme}" >&2
      fail=1
    fi
  fi

  concepts="${d}/_concepts.yaml"
  patterns="${d}/_patterns.yaml"
  decisions="${d}/_decisions.yaml"

  if [[ -f "${concepts}" ]] && ! grep -q '^concepts:' "${concepts}"; then
    echo "FAIL: ${concepts} missing top-level 'concepts:' key" >&2
    fail=1
  fi
  if [[ -f "${patterns}" ]] && ! grep -q '^patterns:' "${patterns}"; then
    echo "FAIL: ${patterns} missing top-level 'patterns:' key" >&2
    fail=1
  fi
  if [[ -f "${decisions}" ]] && ! grep -q '^decisions:' "${decisions}"; then
    echo "FAIL: ${decisions} missing top-level 'decisions:' key" >&2
    fail=1
  fi
done

if [[ "${fail}" -ne 0 ]]; then
  exit 1
fi

echo "docs-standard: PASS"

