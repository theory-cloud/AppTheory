#!/bin/sh
# AWS SDK in a Node container over TLS.
# The handler uses the SDK for JavaScript v3 the nodejs24.x image ships
# (@aws-sdk/client-dynamodb and @aws-sdk/client-apigatewaymanagementapi via
# NODE_PATH=/var/runtime/node_modules), lists the DynamoDB Local tables,
# posts to the runner's TLS @connections endpoint and expects 410 GONE, then
# fetches the app's discovery document over verified https with
# NODE_EXTRA_CA_CERTS as its only trust anchor.
# Run from the repository root; the harness row named in
# scripts/local/examples-local.json is the real proof.
set -eu
go run ./cmd/apptheory-local plan --app examples/cdk/local-tls \
  --profile scripts/local/examples-local.json
