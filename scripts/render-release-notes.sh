#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

tag="${1:-${GITHUB_REF_NAME:-}}"
if [[ -z "${tag}" ]]; then
  echo "release-notes: FAIL (missing tag name)"
  exit 1
fi

version="${tag#v}"

repo="theory-cloud/AppTheory"
repo_url="https://github.com/${repo}"
docs_base="${repo_url}/blob/${tag}"

mkdir -p dist

cat > dist/RELEASE_NOTES.md <<EOF
# AppTheory ${tag}

## Highlights
- Multi-language runtime (Go/TypeScript/Python) with fixture-backed contract tests.
- Deterministic, verifiable release artifacts (checksums + reproducibility gates).

## Breaking changes
- None (initial release).

## Upgrade steps
- Fresh install (no registry publishing; install from GitHub Release assets).

Go:

- \`go get github.com/theory-cloud/apptheory@${tag}\`

TypeScript:

- Download \`theory-cloud-apptheory-${version}.tgz\` from this release.
- \`npm i ./theory-cloud-apptheory-${version}.tgz\`

Python:

- Download an \`apptheory-${version}-*.whl\` (or \`apptheory-${version}.tar.gz\`) from this release.
- \`pip install ./apptheory-${version}-*.whl\`

## Lift migration
- Draft guide: ${docs_base}/docs/migration/from-lift.md
- Migration roadmap: ${docs_base}/docs/development/planning/apptheory/subroadmaps/SR-MIGRATION.md
- Deprecation posture (Pay Theory): ${docs_base}/docs/migration/lift-deprecation.md

## Verification
- \`make rubric\`

Checksums:

- Download \`SHA256SUMS.txt\` and the artifacts into the same directory.
- \`sha256sum -c SHA256SUMS.txt\`
EOF

echo "release-notes: PASS (dist/RELEASE_NOTES.md)"
