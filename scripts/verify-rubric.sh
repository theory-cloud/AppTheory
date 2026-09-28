#!/usr/bin/env bash
# Purpose: run the full local rubric gate used by make rubric and CI.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# The CI rubric is the GovTheory verifier. It owns the deterministic
# gov-infra evidence report and includes the release gate through SEC-4's
# deterministic build check. Keep this wrapper thin so `make rubric`, CI,
# and local validation cannot drift into separate meanings of "rubric".
bash ./scripts/verify-fixture-count.sh
bash ./scripts/verify-fixture-schema.sh
bash ./scripts/verify-invocation-scope.sh
bash ./scripts/verify-cdk-readme-inventory.sh
bash ./scripts/verify-cdk-go-drift.sh
bash ./scripts/verify-api-docs.sh
bash ./gov-infra/verifiers/test-gov-rubric-timestamp.sh
bash ./gov-infra/verifiers/test-gov-retry.sh
# The CI-wiring and install-hygiene guards parse the workflow as YAML and the
# install surfaces as tokenized shell; run their red/green self-tests here so a
# guard that stops failing closed on the reproduced bypasses fails the rubric.
bash ./scripts/test-verify-ci-trigger-parity.sh
bash ./scripts/test-verify-npm-install-hygiene.sh
bash ./gov-infra/verifiers/gov-verify-rubric.sh

echo "rubric: PASS"
