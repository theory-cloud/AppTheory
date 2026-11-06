#!/bin/sh
# Show the root and stage-prefixed REST URLs. Run from the repository root.
# A REST API is served at /{stage}/... in addition to the root:
# https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-call-api.html
#   sh examples/cdk/restv1-router/scripts/stage-prefix.sh
set -eu
go run ./cmd/apptheory-local plan --app examples/cdk/restv1-router \
  --profile scripts/local/examples-local.json
