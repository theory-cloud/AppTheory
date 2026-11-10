#!/bin/sh
# CloudFront in front of the run's own API listener, over TLS.
# The local stage declares the hosted-auth distribution with a custom origin
# auth-api.localhost and OriginProtocolPolicy HTTPS_ONLY, and maps it with
#   --origin auth-api.localhost=https://app.localhost:<api port>
# The row fetches /.well-known/oauth-authorization-server and posts a form to
# /auth/token through the distribution and asserts the API answered with the
# declared origin Host header.
# Run from the repository root; the harness row named in
# scripts/local/examples-local.json is the real proof.
set -eu
go run ./cmd/apptheory-local plan --app examples/cdk/local-tls \
  --profile scripts/local/examples-local.json
