#!/usr/bin/env bash
# Purpose: fail on any asynchronous launch in the shipped runtime trees whose
# join the AST proof cannot show, so no goroutine, thread, task or promise the
# runtime starts outlives the Lambda invocation that started it.
#
# The guard parses TypeScript with the compiler API from ts/node_modules, so it
# installs the repository's TypeScript runtime deps first (the same contract
# verify-ts-dist-drift.sh and the contract runners use). A missing interpreter or
# dependency is a failure, never a skip.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
source "scripts/lib/ts-runtime-deps.sh"

ensure_ts_runtime_deps_installed

go run ./scripts/tools/invocation_scope -root .
go run ./scripts/tools/invocation_scope -selftest

echo "invocation-scope: PASS"
