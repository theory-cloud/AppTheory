#!/bin/sh
# The served custom resources: a Custom::Trigger, a provider-framework handler,
# a Custom::AWS SDK call, and the bucket auto-delete handler's delete leg.
# Run from the repository root; the harness row named in
# scripts/local/examples-local.json is the real proof.
set -eu
go run ./cmd/apptheory-local plan --app examples/cdk/local-resources \
  --profile scripts/local/examples-local.json
