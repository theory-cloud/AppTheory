#!/usr/bin/env bash
# Purpose: render release notes for a tag from the checked-in release metadata.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "--self-test" ]]; then
  temporary="$(mktemp -d)"
  RELEASE_NOTES_OUTPUT_DIR="${temporary}" \
    bash scripts/render-release-notes.sh "v2.0.0-rc.1" >/dev/null
  notes="${temporary}/RELEASE_NOTES.md"
  grep -Fq \
    'go get github.com/theory-cloud/apptheory/v2@v2.0.0-rc.1' \
    "${notes}"
  grep -Fq \
    'go get github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v2@v2.0.0-rc.1' \
    "${notes}"
  grep -Fq \
    'cdk-go/apptheorycdk/v2.0.0-rc.1` targets the same immutable commit as `v2.0.0-rc.1' \
    "${notes}"
  if grep -Fq 'go get github.com/theory-cloud/apptheory@v2.0.0-rc.1' "${notes}"; then
    echo "release-notes self-test: FAIL (v2 notes contain the legacy root module)" >&2
    rm -rf "${temporary}"
    exit 1
  fi
  rm -rf "${temporary}"
  echo "release-notes self-test: PASS (v2 root + nested CDK commands)"
  exit 0
fi

tag="${1:-${GITHUB_REF_NAME:-}}"
if [[ -z "${tag}" ]]; then
  echo "release-notes: FAIL (missing tag name)"
  exit 1
fi

version="${tag#v}"
if [[ ! "${version}" =~ ^([0-9]+)\.[0-9]+\.[0-9]+(-rc(\.[0-9]+)?)?$ ]]; then
  echo "release-notes: FAIL (unsupported tag ${tag})"
  exit 1
fi
major="${BASH_REMATCH[1]}"

go_runtime_module="github.com/theory-cloud/apptheory"
go_cdk_module="github.com/theory-cloud/apptheory/cdk-go/apptheorycdk"
go_cdk_lines="- CDK bindings: import \`${go_cdk_module}\` (legacy v1 tags predate the independently tagged CDK module)."
if (( major >= 2 )); then
  go_runtime_module+="/v${major}"
  go_cdk_module+="/v${major}"
  go_cdk_lines="$(
    cat <<EOF
- CDK: \`go get ${go_cdk_module}@${tag}\`
- CDK import: \`${go_cdk_module}\`
- Tag provenance: \`cdk-go/apptheorycdk/${tag}\` targets the same immutable commit as \`${tag}\`.
EOF
  )"
fi

python_version="${version}"
if [[ "${python_version}" == *"-rc."* ]]; then
  # `X.Y.Z-rc.N` -> `X.Y.ZrcN` (PEP 440 normalized wheel/sdist version)
  python_version="${python_version/-rc./rc}"
elif [[ "${python_version}" == *"-rc" ]]; then
  # `X.Y.Z-rc` -> `X.Y.Zrc0` (TableTheory pattern)
  python_version="${python_version/-rc/rc0}"
fi

repo="theory-cloud/AppTheory"
repo_url="https://github.com/${repo}"
docs_base="${repo_url}/blob/${tag}"
output_dir="${RELEASE_NOTES_OUTPUT_DIR:-dist}"

mkdir -p "${output_dir}"

cat >"${output_dir}/RELEASE_NOTES.md" <<EOF
# AppTheory ${tag}

## Highlights
- Multi-language runtime (Go/TypeScript/Python) with fixture-backed contract tests.
- Lift-compatible AppSync Lambda resolver support across Go, TypeScript, and Python.
- Multi-language CDK (jsii) constructs (TypeScript/Python + Go bindings).
- Deterministic, verifiable release artifacts (checksums + reproducibility gates).

## Breaking changes
- See \`CHANGELOG.md\` for details.

## Upgrade steps
- Fresh install (no registry publishing; install from GitHub Release assets).

Go:

- Runtime: \`go get ${go_runtime_module}@${tag}\`
${go_cdk_lines}

TypeScript:

- Runtime:
  - Download \`theory-cloud-apptheory-${version}.tgz\` from this release.
  - \`npm i ./theory-cloud-apptheory-${version}.tgz\`
- CDK:
  - Download \`theory-cloud-apptheory-cdk-${version}.tgz\` from this release.
  - \`npm i ./theory-cloud-apptheory-cdk-${version}.tgz\`

Python:

- Runtime:
  - Download \`apptheory-${python_version}-*.whl\` (or \`apptheory-${python_version}.tar.gz\`) from this release.
  - \`pip install ./apptheory-${python_version}-*.whl\`
- CDK:
  - Download \`apptheory_cdk-${python_version}-*.whl\` (or \`apptheory_cdk-${python_version}.tar.gz\`) from this release.
  - \`pip install ./apptheory_cdk-${python_version}-*.whl\`

## Lift migration
- Draft guide: ${docs_base}/docs/migration/from-lift.md
- AppSync resolver recipe: ${docs_base}/docs/migration/appsync-lambda-resolvers.md
- Migration roadmap: ${docs_base}/docs/development/planning/apptheory/subroadmaps/SR-MIGRATION.md

## Verification
- Release branch provenance, version alignment, package builds, and checksum generation completed in the publisher.

Checksums:

- Download \`SHA256SUMS.txt\` and the artifacts into the same directory.
- \`sha256sum -c SHA256SUMS.txt\`
EOF

echo "release-notes: PASS (${output_dir}/RELEASE_NOTES.md)"
