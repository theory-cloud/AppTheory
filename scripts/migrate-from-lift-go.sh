#!/usr/bin/env bash
# Purpose: run the Lift-to-AppTheory Go import and API migration helper.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

go run ./cmd/lift-migrate "$@"

