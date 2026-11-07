#!/bin/sh
# Issue an auxiliary service certificate from the run CA and prove a
# container reaches it over verified TLS.
# The harness row runs:
#   apptheory-local tls leaf --data-dir <dir> --name idp.localhost --out <dir>/aux
#   apptheory-local session --app examples/cdk/local-tls --tls --tls-aux idp.localhost ...
# Run from the repository root; the harness row named in
# scripts/local/examples-local.json is the real proof.
set -eu
go run ./cmd/apptheory-local plan --app examples/cdk/local-tls \
  --profile scripts/local/examples-local.json
