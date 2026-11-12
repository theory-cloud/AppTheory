#!/usr/bin/env bash
# Purpose: verify checked-in jsii Go bindings match the CDK TypeScript source.
# Verify checked-in jsii Go bindings match the CDK TypeScript source.
# Usage: ./scripts/verify-cdk-go-drift.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Compose an independently produced drift result when the collector asks for it.
# A non-applicable record falls through to the real regeneration below.
if [[ -n "${APPTHEORY_EVIDENCE_REUSE:-}" ]] && bash scripts/evidence/reuse-if-recorded.sh cdk-go-drift; then
  exit 0
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "cdk-go-drift: FAIL (must run inside a git work tree)" >&2
  exit 1
fi
if [[ ! -d "cdk-go" ]]; then
  echo "cdk-go-drift: FAIL (missing cdk-go/)" >&2
  exit 1
fi

bash ./scripts/update-cdk-generated.sh

# The tarball comparison is content-based: a host whose zlib produces a
# different deflate stream for identical content must not report drift, while a
# content change must still fail. Prove both directions before trusting the
# status check below.
python3 ./scripts/lib/canonicalize-jsii-tarballs.py --self-test

drift_status="$(git status --porcelain=v1 --untracked-files=all -- cdk-go/)"
if [[ -n "${drift_status}" ]]; then
  echo "cdk-go-drift: FAIL (cdk-go bindings are stale; run ./scripts/update-cdk-generated.sh and commit the diff)" >&2
  printf '%s\n' "${drift_status}" >&2
  if ! git diff --quiet -- cdk-go/; then
    git diff --stat -- cdk-go/ >&2 || true
  fi
  exit 1
fi

bash ./scripts/verify-cdk-go-major-version.sh

echo "cdk-go-drift: PASS (current + synthetic next major)"
