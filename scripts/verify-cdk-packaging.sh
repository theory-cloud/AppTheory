#!/usr/bin/env bash
# Purpose: prove the CDK TypeScript pack and Python build without repeating the
# deterministic-build gate's own packaging work.
#
# scripts/verify-builds.sh runs both packaging scripts inside each of its two
# determinism passes. When the full rubric invokes this from its release-gates
# step, that coverage already exists for this exact tree, so packaging a third
# time proves nothing new. The composition is declared explicitly by the rubric
# wrapper and checked here: if the verifier stops running verify-builds.sh, or
# verify-builds.sh stops running a packaging script, the composed claim is
# invalid and this fails closed instead of silently skipping coverage.
#
# Any other caller, and any forced collection, executes the real packaging
# scripts. Tested by scripts/test-verify-cdk-packaging.sh.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

compose="${APPTHEORY_RUBRIC_CDK_PACKAGING_COVERED:-false}"
if [[ "${EVIDENCE_FORCE_EXECUTE:-}" == "true" ]]; then
  compose=false
fi

packaging_scripts=(
  scripts/verify-cdk-ts-pack.sh
  scripts/verify-cdk-python-build.sh
)

if [[ "${compose}" == "true" ]]; then
  if ! grep -Fq "scripts/verify-builds.sh" gov-infra/verifiers/gov-verify-rubric.sh; then
    echo "cdk-packaging: FAIL (the rubric no longer runs verify-builds.sh, so composed coverage is invalid)" >&2
    exit 1
  fi
  for script in "${packaging_scripts[@]}"; do
    if ! grep -Fq "${script}" scripts/verify-builds.sh; then
      echo "cdk-packaging: FAIL (verify-builds.sh no longer runs ${script}; coverage would be lost)" >&2
      exit 1
    fi
  done
  echo "cdk-packaging: PASS (composed from the two deterministic-build passes; no package built here)"
  exit 0
fi

for script in "${packaging_scripts[@]}"; do
  "./${script}"
done
echo "cdk-packaging: PASS (packaged directly once per pass)"
