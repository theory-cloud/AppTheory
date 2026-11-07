#!/bin/sh
# Load the opted-in CloudFront page in headless Chromium and register a
# WebAuthn credential with RP ID app.localhost through the CDP virtual
# authenticator. The harness row runs Playwright with the run leaf's SPKI
# allowlisted; see docs/examples/local-runner.md (Local HTTPS).
# Run from the repository root; the harness row named in
# scripts/local/examples-local.json is the real proof.
set -eu
go run ./cmd/apptheory-local plan --app examples/cdk/local-tls \
  --profile scripts/local/examples-local.json
