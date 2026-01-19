#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

tag="${1:-${GITHUB_REF_NAME:-}}"
if [[ -z "${tag}" ]]; then
  echo "release-notes: FAIL (missing tag name)"
  exit 1
fi

mkdir -p dist

cat > dist/RELEASE_NOTES.md <<EOF
# AppTheory ${tag}

## Highlights
- TODO

## Breaking changes
- None (or TODO)

## Upgrade steps
- TODO

## Lift migration
- Draft guide: docs/migration/from-lift.md
- Migration roadmap: docs/development/planning/apptheory/subroadmaps/SR-MIGRATION.md
- Deprecation posture (Pay Theory): docs/migration/lift-deprecation.md

## Verification
- \`make rubric\`
EOF

echo "release-notes: PASS (dist/RELEASE_NOTES.md)"
