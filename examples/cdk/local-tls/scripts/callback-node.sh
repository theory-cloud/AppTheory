#!/bin/sh
# Fetch the app's OIDC discovery document and JWKS from a Node container.
# The harness row starts a session with --tls, targets CallerNode and invokes
# it with the app's public https URL; NODE_EXTRA_CA_CERTS is the run CA.
# Run from the repository root; the harness row named in
# scripts/local/examples-local.json is the real proof.
set -eu
go run ./cmd/apptheory-local plan --app examples/cdk/local-tls \
  --profile scripts/local/examples-local.json
