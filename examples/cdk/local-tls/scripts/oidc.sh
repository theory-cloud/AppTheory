#!/bin/sh
# OIDC-shaped proof: the issuer is served at the exact https URL it names.
# The harness row fetches discovery and JWKS from the host and from a Go
# container over verified TLS, then compares the issuer to the served URL.
# Run from the repository root; the harness row named in
# scripts/local/examples-local.json is the real proof.
set -eu
go run ./cmd/apptheory-local plan --app examples/cdk/local-tls \
  --profile scripts/local/examples-local.json
