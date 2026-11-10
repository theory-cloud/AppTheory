#!/bin/sh
# CloudFront returns an origin 303 to the viewer instead of following it.
# The local stage declares the hosted-auth distribution in front of the app's
# own API listener and maps its declared origin domain with
#   --origin auth-api.localhost=https://app.localhost:<api port>
# The row posts the SSO form to /auth/authorize through the distribution and
# asserts the viewer receives the 303 with the exact Location at the auxiliary
# idp.localhost certificate, then follows it in a browser over verified TLS.
# Run from the repository root; the harness row named in
# scripts/local/examples-local.json is the real proof.
set -eu
go run ./cmd/apptheory-local plan --app examples/cdk/local-tls \
  --profile scripts/local/examples-local.json
