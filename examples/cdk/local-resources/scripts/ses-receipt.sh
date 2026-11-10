#!/bin/sh
# The SES receipt rule: ses.receive injects a message, the rule's S3 action
# writes the raw body and its Lambda action receives the documented record.
# Run from the repository root; the harness row named in
# scripts/local/examples-local.json is the real proof.
set -eu
go run ./cmd/apptheory-local plan --app examples/cdk/local-resources \
  --profile scripts/local/examples-local.json
