#!/usr/bin/env bash
# Purpose: synthesize CDK examples and compare deterministic template hashes.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib/cdk-runtime-deps.sh
source "scripts/lib/cdk-runtime-deps.sh"

epoch="${SOURCE_DATE_EPOCH:-}"
if [[ -z "${epoch}" ]]; then
  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    epoch="$(git show -s --format=%ct HEAD)"
  else
    epoch="0"
  fi
fi
export SOURCE_DATE_EPOCH="${epoch}"

examples=(
  "examples/cdk/hello-world|AppTheoryHelloWorldGo|-c lang=go"
  "examples/cdk/hello-world|AppTheoryHelloWorldTs|-c lang=ts"
  "examples/cdk/hello-world|AppTheoryHelloWorldPy|-c lang=py"
  "examples/cdk/import-pipeline|AppTheoryImportPipelineDemo|"
  "examples/cdk/kinesis-cloudwatch-logs|AppTheoryKinesisCloudWatchLogsDemo|"
  "examples/cdk/multilang|AppTheoryMultilangDemo|"
  "examples/cdk/microvm-controller|AppTheoryMicrovmControllerDemo|"
  "examples/cdk/s3-vectors-semantic-search|AppTheoryS3VectorsSemanticSearch|"
  "examples/cdk/ssr-site|AppTheorySsrSiteDemo|"
  "examples/cdk/ssr-only-provided-assets-site|AppTheorySsrOnlyProvidedAssetsSiteDemo|"
  "examples/cdk/lesser-parity|LesserParityExample|"
)

if ! command -v node >/dev/null 2>&1; then
  echo "cdk-synth: BLOCKED (node not found)" >&2
  exit 2
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "cdk-synth: BLOCKED (npm not found)" >&2
  exit 2
fi
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  echo "cdk-synth: BLOCKED (sha256sum/shasum not found)" >&2
  exit 2
fi
if [[ ! -d "cdk" ]]; then
  echo "cdk-synth: FAIL (missing cdk/)" >&2
  exit 1
fi
if [[ ! -f "cdk/package-lock.json" ]]; then
  echo "cdk-synth: FAIL (missing cdk/package-lock.json)" >&2
  exit 1
fi
missing_cdk_deps=()
if [[ -d "cdk/node_modules" ]]; then
  for module in constructs aws-cdk-lib; do
    if [[ ! -f "cdk/node_modules/${module}/package.json" ]]; then
      missing_cdk_deps+=("${module}")
    fi
  done
fi
if [[ "${#missing_cdk_deps[@]}" -ne 0 ]]; then
  missing_cdk_deps_list="${missing_cdk_deps[0]}"
  for module in "${missing_cdk_deps[@]:1}"; do
    missing_cdk_deps_list+=", ${module}"
  done
  missing_cdk_deps_noun="module"
  if [[ "${#missing_cdk_deps[@]}" -ne 1 ]]; then
    missing_cdk_deps_noun="modules"
  fi
  echo "cdk-synth: FAIL (CDK dependencies incomplete: missing required CDK ${missing_cdk_deps_noun}: ${missing_cdk_deps_list}; run 'cd cdk && npm ci' or remove stale cdk/node_modules/)" >&2
  exit 1
fi
ensure_cdk_runtime_deps_installed || exit $?

failed=0
for entry in "${examples[@]}"; do
  IFS="|" read -r example_dir stack_name synth_args <<< "${entry}"
  snapshot_dir="${example_dir}/snapshots"
  snapshot_file="${snapshot_dir}/${stack_name}.template.sha256"
  echo "cdk-synth: checking ${example_dir} (${stack_name})"

  if [[ ! -d "${example_dir}" ]]; then
    echo "cdk-synth: FAIL (missing ${example_dir})" >&2
    failed=1
    continue
  fi
  if [[ ! -f "${example_dir}/package-lock.json" ]]; then
    echo "cdk-synth: FAIL (missing ${example_dir}/package-lock.json)" >&2
    failed=1
    continue
  fi
  if [[ ! -f "${snapshot_file}" ]]; then
    echo "cdk-synth: FAIL (missing ${snapshot_file})" >&2
    failed=1
    continue
  fi

  tmp_out="$(mktemp -d)"
  tmp_log="$(mktemp)"
  cleanup() {
    rm -rf "${example_dir}/node_modules" >/dev/null 2>&1 || true
    rm -rf "${tmp_out}"
    rm -f "${tmp_log}"
  }

  if ! (cd "${example_dir}" && npm ci >/dev/null 2>"${tmp_log}"); then
    echo "cdk-synth: FAIL (npm ci failed for ${example_dir})" >&2
    cat "${tmp_log}" >&2
    cleanup
    failed=1
    continue
  fi

  # shellcheck disable=SC2086 # synth_args is a fixed script-owned argument string per example entry.
  if ! (cd "${example_dir}" && npx cdk synth ${synth_args} --quiet --no-notices --no-version-reporting -o "${tmp_out}" >/dev/null 2>"${tmp_log}"); then
    echo "cdk-synth: FAIL (synth failed for ${example_dir})" >&2
    cat "${tmp_log}" >&2
    cleanup
    failed=1
    continue
  fi

  template="${tmp_out}/${stack_name}.template.json"
  if [[ ! -f "${template}" ]]; then
    echo "cdk-synth: FAIL (missing synthesized template ${template})" >&2
    cleanup
    failed=1
    continue
  fi

  expected="$(tr -d ' \t\r\n' < "${snapshot_file}")"
  if [[ -z "${expected}" ]]; then
    echo "cdk-synth: FAIL (empty ${snapshot_file})" >&2
    cleanup
    failed=1
    continue
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    observed="$(sha256sum "${template}" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    observed="$(shasum -a 256 "${template}" | awk '{print $1}')"
  fi

  if [[ "${observed}" != "${expected}" ]]; then
    echo "cdk-synth: FAIL (drift detected)" >&2
    echo "cdk-synth: example ${example_dir}" >&2
    echo "cdk-synth: expected ${expected}" >&2
    echo "cdk-synth: observed ${observed}" >&2
    echo "cdk-synth: re-run 'cd ${example_dir} && npx cdk synth' and update snapshots if intentional" >&2
    cleanup
    failed=1
    continue
  fi

  cleanup
done

if [[ "${failed}" -ne 0 ]]; then
  echo "cdk-synth: FAIL"
  exit 1
fi

echo "cdk-synth: PASS"
