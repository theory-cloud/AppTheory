#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

./scripts/verify-version-alignment.sh
bash ./scripts/verify-branch-release-supply-chain.sh
bash ./scripts/verify-branch-version-sync.sh
./scripts/fmt-check.sh
./scripts/verify-go-lint.sh
./scripts/verify-ts-lint.sh
./scripts/verify-python-lint.sh
./scripts/verify-go.sh
./scripts/verify-ts-pack.sh
./scripts/verify-python-build.sh
./scripts/verify-cdk-constructs.sh
./scripts/verify-cdk-ts-pack.sh
./scripts/verify-cdk-python-build.sh
./scripts/verify-cdk-go.sh
./scripts/verify-cdk-synth.sh
./scripts/verify-api-snapshots.sh
./scripts/verify-contract-tests.sh
./scripts/verify-testkit-examples.sh
bash ./scripts/verify-docs-standard.sh

echo "rubric: PASS"
