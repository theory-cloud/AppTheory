#!/bin/sh
# Serve the multilang app with --watch and rebuild the go handler on a
# source change. Run from the repository root:
#   sh examples/cdk/multilang/scripts/watch-go.sh
# The harness row edits handlers/go, waits for the rebuild and asserts the
# listener URL and the other two functions' execution environments are unchanged.
set -eu
exec go run ./cmd/apptheory-local session \
  --app examples/cdk/multilang \
  --profile scripts/local/examples-local.json \
  --watch --backend dynamodb --backend sqs --backend moto "$@"
