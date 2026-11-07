#!/bin/sh
# A plain http origin mapping to the run's TLS-only API listener must fail
# with a clear message, not a bare 400.
# The row starts the same distribution with
#   --origin auth-api.localhost=http://127.0.0.1:<api port>
# and asserts the run refuses to start, naming OriginProtocolPolicy HTTPS_ONLY
# and the https mapping to use instead.
# Run from the repository root; the harness row named in
# scripts/local/examples-local.json is the real proof.
set -eu
go run ./cmd/apptheory-local plan --app examples/cdk/local-tls \
  --profile scripts/local/examples-local.json
