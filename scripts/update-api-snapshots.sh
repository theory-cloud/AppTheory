#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

./scripts/generate-api-snapshots.sh "api-snapshots"

echo "api-snapshots: updated (api-snapshots/)"

