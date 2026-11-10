#!/bin/sh
# AWS SDK in a Python container over TLS.
# The handler uses boto3 from the python3.14 image, which reads AWS_CA_BUNDLE
# and applies it through its own session, lists the DynamoDB Local tables,
# posts to the runner's TLS @connections endpoint and expects 410 GONE, then
# fetches the app's discovery document over verified https with
# SSL_CERT_FILE and REQUESTS_CA_BUNDLE.
# Run from the repository root; the harness row named in
# scripts/local/examples-local.json is the real proof.
set -eu
go run ./cmd/apptheory-local plan --app examples/cdk/local-tls \
  --profile scripts/local/examples-local.json
