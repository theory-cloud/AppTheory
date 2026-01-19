#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

./scripts/verify-version-alignment.sh
./scripts/verify-go.sh
./scripts/verify-ts-pack.sh
./scripts/verify-python-build.sh
./scripts/verify-contract-tests.sh
./scripts/verify-testkit-examples.sh

echo "rubric: PASS"
