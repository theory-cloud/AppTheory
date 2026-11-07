#!/bin/sh
# Keep KMS key material across two invokes. Run from the repository root; the
# harness row invokes the signing handler with mode=data-dir-write, then
# mode=data-dir-read with the values from the first result and the same
# --data-dir.
#   sh examples/cdk/kinesis-cloudwatch-logs/scripts/data-dir-kms.sh "$HOME/.apptheory-local-data/kinesis"
set -eu
data_dir=${1:-"$HOME/.apptheory-local-data/kinesis"}
printf '%s\n' '{"mode":"data-dir-write"}' |
  go run ./cmd/apptheory-local invoke --app examples/cdk/kinesis-cloudwatch-logs \
    --profile scripts/local/examples-local.json --backend moto \
    --data-dir "$data_dir" --stdio
