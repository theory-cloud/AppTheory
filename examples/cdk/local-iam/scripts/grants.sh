#!/bin/sh
# The local IAM example's grants row: a real apptheory-local session proves it.
# Run from the repository root; the harness row named in
# scripts/local/examples-local.json is the real proof.
set -eu
go run ./cmd/apptheory-local plan --app examples/cdk/local-iam \
  --profile scripts/local/examples-local.json
