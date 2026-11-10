#!/bin/sh
# Serve the multilang app with --watch and edit two handlers in succession.
# Run from the repository root:
#   sh examples/cdk/multilang/scripts/watch-two-edit.sh
# The harness row edits handlers/go, asserts the Go function was replaced, then
# edits handlers/ts and asserts the TypeScript function was replaced while the
# already-restarted Go function stayed untouched and kept answering.
set -eu
exec go run ./cmd/apptheory-local session \
  --app examples/cdk/multilang \
  --profile scripts/local/examples-local.json \
  --watch --backend dynamodb --backend sqs --backend moto "$@"
