#!/bin/sh
# Keep an ElasticMQ message across two sessions. Run from the repository root;
# the harness row sends to an unconsumed queue, stops, starts a second session
# with the same --data-dir and receives the message.
#   sh examples/cdk/sqs-queue/scripts/data-dir-sqs.sh "$HOME/.apptheory-local-data/sqs"
set -eu
data_dir=${1:-"$HOME/.apptheory-local-data/sqs"}
exec go run ./cmd/apptheory-local session \
  --app examples/cdk/sqs-queue \
  --profile scripts/local/examples-local.json \
  --backend sqs --backend dynamodb --backend moto --data-dir "$data_dir"
