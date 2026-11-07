#!/bin/sh
# Write and read one object with SSE-S3. Run from the repository root; the
# harness row runs a session and invokes the custom handler with sse=1, write,
# then sse=1, read.
#   sh examples/cdk/lambda-role/scripts/s3-sse.sh
set -eu
printf '%s\n' '{"queryStringParameters":{"key":"sse/probe.txt","write":"1","value":"sse-value","sse":"1"}}' |
  go run ./cmd/apptheory-local invoke --app examples/cdk/lambda-role --function CustomFnFE03B841 \
    --profile scripts/local/examples-local.json --backend s3proxy --backend moto --stdio
printf '%s\n' '{"queryStringParameters":{"key":"sse/probe.txt","read":"1","sse":"1"}}' |
  go run ./cmd/apptheory-local invoke --app examples/cdk/lambda-role --function CustomFnFE03B841 \
    --profile scripts/local/examples-local.json --backend s3proxy --backend moto --stdio
