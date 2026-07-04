#!/usr/bin/env bash
# Purpose: verify the cdk/README.md construct inventory matches cdk/lib/index.ts exports.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

bash ./scripts/update-cdk-readme-inventory.sh --check
