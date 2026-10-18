#!/usr/bin/env bash
# Purpose: lightweight dependency/vulnerability scan for every pull request.
#
# This gate refreshes the security signal on promotion revisions (premain/main
# pull requests) without running the full rubric or the deterministic-build job.
# It scans the dependency graph rather than the whole repository:
#   - govulncheck on the root Go module and the checked-in cdk-go module
#   - npm audit for the published TypeScript and CDK packages plus the CDK
#     examples (the CDK package graph is routed through the repository's
#     reviewed npm-audit exception checker)
#   - pip-audit for the Python requirement manifests
#
# Findings fail closed. pip-audit has no severity threshold, so it fails on any
# reported vulnerability, which is stricter than the high/critical floor.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Pins mirror gov-infra/verifiers/gov-verify-rubric.sh; keep them aligned.
PIN_GOVULNCHECK_VERSION="v1.8.0"
PIN_PIP_AUDIT_VERSION="2.10.0"

work_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${work_dir}"
}
trap cleanup EXIT

tool_bin="${work_dir}/bin"
mkdir -p "${tool_bin}"
export PATH="${tool_bin}:${PATH}"

fail() {
  echo "security-refresh: FAIL ($1)" >&2
  exit 1
}

blocked() {
  echo "security-refresh: BLOCKED ($1)" >&2
  exit 2
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || blocked "missing required command: $1"
}

go_tool_mod_version() {
  local tool="$1"
  local path
  path="$(command -v "${tool}" 2>/dev/null || true)"
  if [[ -z "${path}" ]]; then
    return 1
  fi
  go version -m "${path}" 2>/dev/null | awk '$1 == "mod" { print $3; exit }'
}

ensure_govulncheck_pinned() {
  require_cmd go

  if [[ "$(go_tool_mod_version govulncheck || true)" == "${PIN_GOVULNCHECK_VERSION}" ]]; then
    return 0
  fi

  echo "Installing govulncheck ${PIN_GOVULNCHECK_VERSION} into ${tool_bin}..." >&2
  if ! GOBIN="${tool_bin}" go install "golang.org/x/vuln/cmd/govulncheck@${PIN_GOVULNCHECK_VERSION}"; then
    blocked "failed to install pinned govulncheck ${PIN_GOVULNCHECK_VERSION} (check network/toolchain)"
  fi

  if [[ "$(go_tool_mod_version govulncheck || true)" != "${PIN_GOVULNCHECK_VERSION}" ]]; then
    fail "installed govulncheck does not match expected version ${PIN_GOVULNCHECK_VERSION}"
  fi
}

ensure_pip_audit_pinned() {
  require_cmd python3

  local venv_dir="${work_dir}/pip-audit"
  if [[ ! -x "${venv_dir}/bin/pip-audit" ]]; then
    echo "Installing pip-audit ${PIN_PIP_AUDIT_VERSION} into ${venv_dir}..." >&2
    if ! python3 -m venv "${venv_dir}"; then
      blocked "failed to create pip-audit virtualenv"
    fi
    if ! "${venv_dir}/bin/python" -m pip install --disable-pip-version-check --no-cache-dir \
      "pip-audit==${PIN_PIP_AUDIT_VERSION}"; then
      blocked "failed to install pinned pip-audit ${PIN_PIP_AUDIT_VERSION} (check network/toolchain)"
    fi
  fi

  if ! "${venv_dir}/bin/pip-audit" --version 2>/dev/null | grep -Fq "pip-audit ${PIN_PIP_AUDIT_VERSION}"; then
    fail "installed pip-audit does not match expected version ${PIN_PIP_AUDIT_VERSION}"
  fi

  export PIP_AUDIT_BIN="${venv_dir}/bin/pip-audit"
}

scan_go() {
  require_cmd go
  ensure_govulncheck_pinned

  local -a packages=()
  mapfile -t packages < <(./scripts/list-go-packages.sh)
  if [[ "${#packages[@]}" -eq 0 ]]; then
    fail "no root Go packages selected for govulncheck"
  fi

  echo "==> govulncheck (root module, ${#packages[@]} packages)" >&2
  govulncheck "${packages[@]}" || fail "govulncheck reported vulnerabilities in the root module"

  if [[ -f "cdk-go/apptheorycdk/go.mod" ]]; then
    echo "==> govulncheck (cdk-go/apptheorycdk module)" >&2
    (cd cdk-go/apptheorycdk && govulncheck ./...) || fail "govulncheck reported vulnerabilities in cdk-go/apptheorycdk"
  fi
}

scan_npm() {
  require_cmd npm

  # The CDK graph carries a reviewed, self-expiring aws-cdk-lib bundled-dependency
  # exception. Reuse the repository gate so only that reviewed finding is allowed.
  if [[ -f "cdk/package-lock.json" ]]; then
    echo "==> npm audit (cdk, reviewed-exception gate)" >&2
    bash scripts/verify-cdk-audit.sh || fail "CDK dependency audit failed"
  fi

  local lockfile
  local package_dir
  for lockfile in ts/package-lock.json examples/cdk/*/package-lock.json; do
    if [[ ! -f "${lockfile}" ]]; then
      continue
    fi
    package_dir="$(dirname "${lockfile}")"
    echo "==> npm audit --omit=dev --audit-level=high (${package_dir})" >&2
    (cd "${package_dir}" && npm audit --omit=dev --audit-level=high) \
      || fail "npm audit reported high/critical vulnerabilities in ${lockfile}"
  done
}

scan_python() {
  require_cmd python3

  local -a requirement_args=()
  local requirement
  for requirement in \
    "py/requirements-build.txt" \
    "py/requirements-lint.txt" \
    "cdk/requirements-build.txt"; do
    if [[ -f "${requirement}" ]]; then
      requirement_args+=("-r" "${requirement}")
    fi
  done

  if [[ "${#requirement_args[@]}" -eq 0 ]]; then
    echo "==> pip-audit (no requirement manifests found)" >&2
    return 0
  fi

  ensure_pip_audit_pinned

  echo "==> pip-audit ${requirement_args[*]}" >&2
  "${PIP_AUDIT_BIN}" "${requirement_args[@]}" || fail "pip-audit reported vulnerabilities"
}

echo "security-refresh: scanning revision $(git rev-parse HEAD 2>/dev/null || echo unknown)" >&2

scan_go
scan_npm
scan_python

echo "security-refresh: PASS"
