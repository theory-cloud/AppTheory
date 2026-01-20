#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

./scripts/verify-version-alignment.sh
./scripts/verify-go.sh
./scripts/verify-ts-pack.sh
./scripts/verify-python-build.sh
./scripts/verify-cdk-constructs.sh
./scripts/verify-cdk-ts-pack.sh
./scripts/verify-cdk-python-build.sh
./scripts/verify-cdk-go.sh
./scripts/verify-cdk-synth.sh
./scripts/verify-contract-tests.sh
./scripts/verify-testkit-examples.sh

echo "rubric: PASS"
