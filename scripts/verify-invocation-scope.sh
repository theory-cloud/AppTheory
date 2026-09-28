#!/usr/bin/env bash
# Purpose: fail on any asynchronous launch in the shipped runtime trees that has
# no recorded join, so no goroutine, thread, task or promise the runtime starts
# can outlive the Lambda invocation that started it.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

go run ./scripts/tools/invocation_scope -root .

echo "invocation-scope: PASS"
