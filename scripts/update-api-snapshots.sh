#!/usr/bin/env bash
# Purpose: refresh all committed API snapshots after an intentional public surface change.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

./scripts/generate-api-snapshots.sh "api-snapshots"

echo "api-snapshots: updated (api-snapshots/)"

