#!/bin/sh
# Keep the table across two runs. Run from the repository root, twice with the
# same --data-dir; the session protocol (stdin/stdout) is in
# docs/examples/local-runner.md.
#   sh examples/cdk/lesser-parity/scripts/data-dir.sh "$HOME/.apptheory-local-data/lesser-parity"
# Run 1: PUT /items/persisted on the printed REST URL.
# Run 2: GET /items/persisted and read the value back.
set -eu
data_dir=${1:-"$HOME/.apptheory-local-data/lesser-parity"}
exec go run ./cmd/apptheory-local session \
  --app examples/cdk/lesser-parity \
  --profile scripts/local/examples-local.json \
  --backend dynamodb --data-dir "$data_dir"
