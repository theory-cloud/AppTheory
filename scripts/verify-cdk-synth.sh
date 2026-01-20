#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

examples=(
  "examples/cdk/multilang|AppTheoryMultilangDemo"
  "examples/cdk/ssr-site|AppTheorySsrSiteDemo"
)

if ! command -v node >/dev/null 2>&1; then
  echo "cdk-synth: BLOCKED (node not found)" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "cdk-synth: BLOCKED (npm not found)" >&2
  exit 1
fi

for entry in "${examples[@]}"; do
  example_dir="${entry%%|*}"
  stack_name="${entry##*|}"
  snapshot_dir="${example_dir}/snapshots"
  snapshot_file="${snapshot_dir}/${stack_name}.template.sha256"

  if [[ ! -d "${example_dir}" ]]; then
    echo "cdk-synth: FAIL (missing ${example_dir})" >&2
    exit 1
  fi
  if [[ ! -f "${example_dir}/package-lock.json" ]]; then
    echo "cdk-synth: FAIL (missing ${example_dir}/package-lock.json)" >&2
    exit 1
  fi
  if [[ ! -f "${snapshot_file}" ]]; then
    echo "cdk-synth: FAIL (missing ${snapshot_file})" >&2
    exit 1
  fi

  (cd "${example_dir}" && npm ci >/dev/null)

  tmp_out="$(mktemp -d)"
  tmp_log="$(mktemp)"
  cleanup() {
    rm -rf "${example_dir}/node_modules" >/dev/null 2>&1 || true
    rm -rf "${tmp_out}"
    rm -f "${tmp_log}"
  }

  if ! (cd "${example_dir}" && npx cdk synth --quiet --no-notices --no-version-reporting -o "${tmp_out}" >/dev/null 2>"${tmp_log}"); then
    echo "cdk-synth: FAIL (synth failed for ${example_dir})" >&2
    cat "${tmp_log}" >&2
    cleanup
    exit 1
  fi

  template="${tmp_out}/${stack_name}.template.json"
  if [[ ! -f "${template}" ]]; then
    echo "cdk-synth: FAIL (missing synthesized template ${template})" >&2
    cleanup
    exit 1
  fi

  expected="$(tr -d ' \t\r\n' < "${snapshot_file}")"
  if [[ -z "${expected}" ]]; then
    echo "cdk-synth: FAIL (empty ${snapshot_file})" >&2
    cleanup
    exit 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    observed="$(sha256sum "${template}" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    observed="$(shasum -a 256 "${template}" | awk '{print $1}')"
  else
    echo "cdk-synth: FAIL (missing sha256sum/shasum)" >&2
    cleanup
    exit 1
  fi

  if [[ "${observed}" != "${expected}" ]]; then
    echo "cdk-synth: FAIL (drift detected)" >&2
    echo "cdk-synth: example ${example_dir}" >&2
    echo "cdk-synth: expected ${expected}" >&2
    echo "cdk-synth: observed ${observed}" >&2
    echo "cdk-synth: re-run 'cd ${example_dir} && npx cdk synth' and update snapshots if intentional" >&2
    cleanup
    exit 1
  fi

  cleanup
done

echo "cdk-synth: PASS"
