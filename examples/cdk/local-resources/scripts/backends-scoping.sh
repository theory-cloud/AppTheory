#!/bin/sh
# Two co-resident runs on one shared network, each with its own moto and
# s3proxy: each run's injected endpoints carry its own scoped alias.
# Run from the repository root; the harness row named in
# scripts/local/examples-local.json is the real proof.
set -eu
go run ./cmd/apptheory-local plan --app examples/cdk/local-resources \
  --profile scripts/local/examples-local.json
