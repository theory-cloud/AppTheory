#!/usr/bin/env bash
# Purpose: verify release artifact completeness for the checks the dedicated
# product jobs and the deterministic-build gate do not own.
#
# This runs once in the full rubric. It is not part of the deterministic-build
# loop: a build pass proves artifact reproducibility, not CDK synthesis or
# runtime-floor claims, and repeating those inside both build passes duplicated
# the suite without strengthening that claim. The CDK packs are composed from
# the deterministic-build passes through verify-cdk-packaging.sh rather than
# built a third time.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

bash ./scripts/verify-runtime-floor-claims.sh
./scripts/verify-cdk-audit.sh
./scripts/verify-cdk-engines-floor.sh
./scripts/verify-cdk-constructs.sh
./scripts/verify-cdk-deprecation-warnings.sh
./scripts/verify-cdk-packaging.sh
./scripts/verify-cdk-go.sh
./scripts/verify-cdk-synth.sh
./scripts/verify-microvm-conformance-harness.sh
# The scaffold gate above packs the working tree; this pairs the templates with the
# release-candidate tarball at the VERSION tag the templates substitute.
bash ./scripts/verify-release-pairing.sh --self-test
bash ./scripts/verify-release-pairing.sh

echo "release-gates: PASS (release artifact completeness)"
