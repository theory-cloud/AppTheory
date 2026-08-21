#!/usr/bin/env bash
# Purpose: verify AppTheory testkit examples compile and pass.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/lib/ts-runtime-deps.sh
source "${SCRIPT_DIR}/lib/ts-runtime-deps.sh"

cd "${REPO_ROOT}"

require_cmd_or_blocked go || exit $?
require_cmd_or_blocked node || exit $?
require_cmd_or_blocked npm || exit $?
require_cmd_or_blocked python3 || exit $?

ensure_ts_runtime_deps_installed

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
