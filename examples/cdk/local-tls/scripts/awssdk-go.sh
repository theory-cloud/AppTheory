#!/bin/sh
# AWS SDK in a Go container over TLS, with a caller-supplied *http.Client.
# The handler loads the SDK config with its own &http.Client{} (the shape a
# table mapper uses), lists the DynamoDB Local tables, posts to the runner's
# TLS @connections endpoint and expects 410 GONE for an unknown connection,
# then fetches the app's discovery document over verified https.
# The Go container receives SSL_CERT_FILE and never AWS_CA_BUNDLE, because the
# SDK refuses a config that carries the bundle with a custom client.
# Run from the repository root; the harness row named in
# scripts/local/examples-local.json is the real proof.
set -eu
go run ./cmd/apptheory-local plan --app examples/cdk/local-tls \
  --profile scripts/local/examples-local.json
