#!/bin/sh
# The versioned bucket: two puts return two distinct version ids, both read
# back by version id through the AWS SDK.
# Run from the repository root; the harness row named in
# scripts/local/examples-local.json is the real proof.
set -eu
go run ./cmd/apptheory-local plan --app examples/cdk/local-resources \
  --profile scripts/local/examples-local.json
