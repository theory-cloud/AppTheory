#!/bin/sh
# The resource-type inventory: every type docs/127 Problem 4 lists is served,
# reported as deploy-time-only with a docs/125 true-limit reason, or refused by
# name.
# Run from the repository root; the harness row named in
# scripts/local/examples-local.json is the real proof.
set -eu
go run ./cmd/apptheory-local plan --app examples/cdk/local-resources \
  --profile scripts/local/examples-local.json
