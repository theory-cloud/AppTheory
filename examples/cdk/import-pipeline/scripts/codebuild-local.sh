#!/bin/sh
# Start the import-pipeline CodeBuild project through the local CodeBuild API.
# Run from the repository root; a session prints the codebuild endpoint and the
# project name in `session describe`. The harness row does the same with
# StartBuild, BatchGetBuilds and ListBuildsForProject over the JSON 1.1 API.
#   sh examples/cdk/import-pipeline/scripts/codebuild-local.sh
set -eu
go run ./cmd/apptheory-local session \
  --app examples/cdk/import-pipeline \
  --profile scripts/local/examples-local.json \
  --backend dynamodb --backend s3proxy --backend sqs --backend moto
