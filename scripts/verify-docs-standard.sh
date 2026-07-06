#!/usr/bin/env bash
# Purpose: verify docs front matter, navigation, links, and release-install placeholders.
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
  "_contract.yaml"
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

  contract="${d}/_contract.yaml"
  if [[ -f "${contract}" ]] && ! grep -q '^contract:' "${contract}"; then
    echo "FAIL: ${contract} missing top-level 'contract:' key" >&2
    fail=1
  fi

  if [[ -f "${readme}" ]] && ! grep -q '\./_contract.yaml' "${readme}"; then
    echo "FAIL: ${readme} missing link to docs contract" >&2
    fail=1
  fi

  dev_guidelines="${d}/development-guidelines.md"
  if [[ -f "${dev_guidelines}" ]] && ! grep -qi 'contract-only' "${dev_guidelines}"; then
    echo "FAIL: ${dev_guidelines} must clearly state contract-only scope" >&2
    fail=1
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


config="docs/_config.yml"
if [[ -f "${config}" ]]; then
  for excluded_path in '"development/planning/"' '"planning/"'; do
    if ! grep -Fq "${excluded_path}" "${config}"; then
      echo "FAIL: ${config} must exclude planning publish path ${excluded_path}" >&2
      fail=1
    fi
  done
fi

contract="docs/_contract.yaml"
if [[ -f "${contract}" ]]; then
  for out_of_scope_path in "docs/development/planning/**" "docs/planning/**"; do
    if ! grep -Fq "${out_of_scope_path}" "${contract}"; then
      echo "FAIL: ${contract} must mark ${out_of_scope_path} out_of_scope" >&2
      fail=1
    fi
  done
fi

for duplicate_migration_entry in "docs/migration/README.md" "docs/migration/index.md"; do
  if [[ -e "${duplicate_migration_entry}" ]]; then
    echo "FAIL: duplicate migration entrypoint: ${duplicate_migration_entry}; use docs/migration-guide.md" >&2
    fail=1
  fi
done

if [[ -f "docs/_data/nav.yml" ]] && grep -Eq 'url:[[:space:]]*/migration/(,|[[:space:]]*$)' "docs/_data/nav.yml"; then
  echo "FAIL: docs/_data/nav.yml must not publish /migration/ as a duplicate migration entrypoint" >&2
  fail=1
fi

if [[ "${fail}" -ne 0 ]]; then
  exit 1
fi

echo "docs-standard: PASS"
