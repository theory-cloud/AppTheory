#!/usr/bin/env bash
# Purpose: verify AppTheory testkit examples compile and pass.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v go >/dev/null 2>&1; then
  echo "examples: BLOCKED (go not found)" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "examples: BLOCKED (node not found)" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "examples: BLOCKED (npm not found)" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "examples: BLOCKED (python3 not found)" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  lock_hash="$(sha256sum ts/package-lock.json | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  lock_hash="$(shasum -a 256 ts/package-lock.json | awk '{print $1}')"
else
  echo "examples: BLOCKED (sha256 tool not found)" >&2
  exit 2
fi

stamp="ts/node_modules/.gov-ts-runtime-deps.sha256"
if [[ ! -d ts/node_modules ]] || [[ ! -f "${stamp}" ]] || ! grep -Fxq "${lock_hash}" "${stamp}" 2>/dev/null; then
  echo "Installing TypeScript runtime deps into ts/node_modules..." >&2
  if ! (cd ts && npm ci --no-audit --no-fund >/dev/null); then
    echo "examples: BLOCKED (failed to install TypeScript runtime dependencies)" >&2
    exit 2
  fi
  printf '%s\n' "${lock_hash}" >"${stamp}"
fi

node examples/testkit/ts.mjs
node examples/testkit/ts-streaming.mjs
go test ./examples/cdk/hello-world/handlers/go
go test ./examples/cdk/s3-vectors-semantic-search/handler
node examples/cdk/hello-world/handlers/ts/handler.test.mjs
python3 examples/cdk/hello-world/handlers/py/handler_test.py
node --check examples/mcp/tools-only-ts/server.mjs
node --check examples/mcp/tools-only-ts/server.test.mjs
node examples/mcp/tools-only-ts/server.test.mjs
python3 examples/testkit/py.py
python3 examples/mcp/tools-only-py/server_test.py
./scripts/verify-scaffold-examples.sh

echo "examples: PASS"
