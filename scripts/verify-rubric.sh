#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# The CI rubric is the GovTheory verifier. It owns the deterministic
# gov-infra evidence report and includes the release gate through SEC-4's
# deterministic build check. Keep this wrapper thin so `make rubric`, CI,
# and local validation cannot drift into separate meanings of "rubric".
bash ./scripts/verify-fixture-count.sh
bash ./gov-infra/verifiers/gov-verify-rubric.sh

echo "rubric: PASS"
