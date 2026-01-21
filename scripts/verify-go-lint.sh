#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PIN_GOLANGCI_LINT_VERSION="v2.5.0"
GOV_TOOLS_BIN="$(pwd)/gov-infra/.tools/bin"
mkdir -p "${GOV_TOOLS_BIN}"
export PATH="${GOV_TOOLS_BIN}:${PATH}"

ensure_golangci_lint_pinned() {
  local v="${PIN_GOLANGCI_LINT_VERSION}"
  local want="${v#v}"

  if command -v golangci-lint >/dev/null 2>&1; then
    if golangci-lint --version 2>/dev/null | grep -q "${want}"; then
      return 0
    fi
  fi

  if ! command -v go >/dev/null 2>&1; then
    echo "go-lint: FAIL (missing go; needed to install pinned golangci-lint ${v})" >&2
    exit 1
  fi

  echo "go-lint: installing pinned golangci-lint ${v} into ${GOV_TOOLS_BIN}" >&2
  GOBIN="${GOV_TOOLS_BIN}" go install "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@${v}"

  golangci-lint --version 2>/dev/null | grep -q "${want}" || {
    echo "go-lint: FAIL (installed golangci-lint does not report expected version ${v})" >&2
    golangci-lint --version 2>/dev/null || true
    exit 1
  }
}

ensure_golangci_lint_pinned

golangci-lint run --timeout=5m --config .golangci-v2.yml ./...

echo "go-lint: PASS"
