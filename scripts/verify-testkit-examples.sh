#!/usr/bin/env bash
# Purpose: verify AppTheory testkit examples compile and pass.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "examples: BLOCKED (node not found)" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "examples: BLOCKED (python3 not found)" >&2
  exit 1
fi
if ! command -v go >/dev/null 2>&1; then
  echo "examples: BLOCKED (go not found)" >&2
  exit 1
fi

node examples/testkit/ts.mjs
node examples/testkit/ts-streaming.mjs
go test ./examples/cdk/hello-world/handlers/go
node examples/cdk/hello-world/handlers/ts/handler.test.mjs
python3 examples/cdk/hello-world/handlers/py/handler_test.py
node --check examples/mcp/tools-only-ts/server.mjs
node --check examples/mcp/tools-only-ts/server.test.mjs
node examples/mcp/tools-only-ts/server.test.mjs
python3 examples/testkit/py.py
python3 examples/mcp/tools-only-py/server_test.py

echo "examples: PASS"
