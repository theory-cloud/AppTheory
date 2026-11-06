#!/bin/sh
# Keep an S3 object across two invokes. Run from the repository root; the
# harness row invokes the custom handler with write=1 then read=1 and the same
# --data-dir.
#   sh examples/cdk/lambda-role/scripts/data-dir-s3.sh "$HOME/.apptheory-local-data/lambda-role"
set -eu
data_dir=${1:-"$HOME/.apptheory-local-data/lambda-role"}
printf '%s\n' '{"queryStringParameters":{"key":"data-dir/persisted.txt","write":"1","value":"kept"}}' |
  go run ./cmd/apptheory-local invoke --app examples/cdk/lambda-role --function CustomFnFE03B841 \
    --profile scripts/local/examples-local.json --backend s3proxy --backend moto \
    --data-dir "$data_dir" --stdio
printf '%s\n' '{"queryStringParameters":{"key":"data-dir/persisted.txt","read":"1"}}' |
  go run ./cmd/apptheory-local invoke --app examples/cdk/lambda-role --function CustomFnFE03B841 \
    --profile scripts/local/examples-local.json --backend s3proxy --backend moto \
    --data-dir "$data_dir" --stdio
