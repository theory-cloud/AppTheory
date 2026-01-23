#!/usr/bin/env bash
# GovTheory Rubric Verifier (Single Entrypoint)
# Generated from pack version: 2ba585f48951
# Project: AppTheory (apptheory)
#
# This script is the deterministic verifier entrypoint for gov.validate.
# It reads planning state from gov-infra/planning/, runs repo-specific check
# commands, writes evidence under gov-infra/evidence/, and emits a fixed JSON
# report at gov-infra/evidence/gov-rubric-report.json.
#
# Usage (from repo root; scripts may be non-executable by default):
#   bash gov-infra/verifiers/gov-verify-rubric.sh
#
# Exit codes:
#   0 - All rubric items PASS
#   1 - One or more rubric items FAIL or BLOCKED
#   2 - Script error (missing dependencies, invalid config, etc.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
GOV_INFRA="${REPO_ROOT}/gov-infra"
PLANNING_DIR="${GOV_INFRA}/planning"
EVIDENCE_DIR="${GOV_INFRA}/evidence"
REPORT_PATH="${EVIDENCE_DIR}/gov-rubric-report.json"

# Always run checks from repo root so relative commands are stable.
cd "${REPO_ROOT}"

# Optional repo-local tools directory (to enforce pinned tool versions deterministically).
# Tools are installed here (never system-wide) and put first on PATH.
GOV_TOOLS_DIR="${GOV_INFRA}/.tools"
GOV_TOOLS_BIN="${GOV_TOOLS_DIR}/bin"
GOV_TOOLS_PY_DIR="${GOV_TOOLS_DIR}/py"
GOV_TOOLS_PY_BIN="${GOV_TOOLS_PY_DIR}/bin"
GOV_TOOLS_PY_COV_DIR="${GOV_TOOLS_DIR}/py-coverage"
GOV_TOOLS_PY_COV_BIN="${GOV_TOOLS_PY_COV_DIR}/bin"
GOV_TOOLS_PY_RUNTIME_DIR="${GOV_TOOLS_DIR}/py-runtime"
GOV_TOOLS_PY_RUNTIME_BIN="${GOV_TOOLS_PY_RUNTIME_DIR}/bin"
mkdir -p "${GOV_TOOLS_BIN}"
export PATH="${GOV_TOOLS_BIN}:${GOV_TOOLS_PY_BIN}:${GOV_TOOLS_PY_RUNTIME_BIN}:${PATH}"

# Tool pins (optional; populated by gov.init when possible).
# If these remain unset, checks that depend on them should be marked BLOCKED (never "use whatever is installed").
PIN_GOLANGCI_LINT_VERSION="v2.8.0"
PIN_GOVULNCHECK_VERSION="v1.1.4"
PIN_OSV_SCANNER_VERSION="v1.9.2"
PIN_PIP_AUDIT_VERSION="2.10.0"
PIN_PY_COVERAGE_VERSION="7.6.10"

# Optional feature flags (opt-in pack features).
FEATURE_OSS_RELEASE="false"

# Coverage threshold (anti-drift; must match rubric docs).
COV_THRESHOLD="90"

# Ensure evidence directory exists
mkdir -p "${EVIDENCE_DIR}"

# Clean previous run outputs to prevent stale evidence from being misattributed.
rm -f \
  "${REPORT_PATH}" \
  "${EVIDENCE_DIR}/"*-output.log \
  "${EVIDENCE_DIR}/DOC-5-parity.log" \
  "${EVIDENCE_DIR}/go-coverage.out" \
  "${EVIDENCE_DIR}/go-coverage-summary.txt" \
  "${EVIDENCE_DIR}/ts-coverage-summary.txt" \
  "${EVIDENCE_DIR}/py-coverage-summary.txt" \
  "${EVIDENCE_DIR}/py-coverage.data"

# Initialize report structure
REPORT_SCHEMA_VERSION=1
REPORT_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PASS_COUNT=0
FAIL_COUNT=0
BLOCKED_COUNT=0

declare -a RESULTS=()

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  printf '%s' "$s"
}

record_result() {
  local id="$1"
  local category="$2"
  local status="$3"
  local message="$4"
  local evidence_path="$5"

  case "$status" in
    PASS) ((PASS_COUNT++)) || true ;;
    FAIL) ((FAIL_COUNT++)) || true ;;
    BLOCKED) ((BLOCKED_COUNT++)) || true ;;
    *) echo "Internal error: invalid status '${status}'" >&2; exit 2 ;;
  esac

  RESULTS+=(
    "{\"id\":\"$(json_escape "$id")\",\"category\":\"$(json_escape "$category")\",\"status\":\"$(json_escape "$status")\",\"message\":\"$(json_escape "$message")\",\"evidencePath\":\"$(json_escape "$evidence_path")\"}"
  )
}

is_unset_token() {
  local v="$1"
  [[ -z "${v//[[:space:]]/}" ]] && return 0
  [[ "$v" == "UNSET:"* ]] && return 0
  [[ "$v" == "BLOCKED:"* ]] && return 0
  [[ "$v" == "{{"* ]] && return 0
  return 1
}

require_cmd_or_blocked() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "BLOCKED: missing required tool: ${name}" >&2
    return 2
  fi
  return 0
}

normalize_feature_flags() {
  if is_unset_token "$FEATURE_OSS_RELEASE"; then
    FEATURE_OSS_RELEASE="false"
  fi
  FEATURE_OSS_RELEASE="$(printf '%s' "$FEATURE_OSS_RELEASE" | tr '[:upper:]' '[:lower:]')"
  case "$FEATURE_OSS_RELEASE" in
    true|false) ;;
    *) FEATURE_OSS_RELEASE="false" ;;
  esac
}

ensure_golangci_lint_pinned() {
  ensure_go_tool_pinned \
    "golangci-lint" \
    "github.com/golangci/golangci-lint/v2/cmd/golangci-lint" \
    "${PIN_GOLANGCI_LINT_VERSION}"
}

go_tool_mod_version() {
  # Returns the module version embedded in a Go-built tool binary, or exits non-zero if unavailable.
  local tool_name="$1"
  local tool_path
  tool_path="$(command -v "${tool_name}" 2>/dev/null || true)"
  [[ -n "${tool_path}" ]] || return 1
  go version -m "${tool_path}" 2>/dev/null | awk '$1 == "mod" { print $3; exit }'
}

ensure_go_tool_pinned() {
  # Installs a Go tool into ${GOV_TOOLS_BIN} at a pinned version.
  #
  # Returns:
  #   0 - success
  #   2 - BLOCKED (missing go toolchain / install failed)
  local tool_name="$1"       # e.g. golangci-lint
  local module_path="$2"     # e.g. github.com/.../cmd/golangci-lint
  local version="$3"         # e.g. v2.8.0

  if is_unset_token "${version}"; then
    echo "BLOCKED: ${tool_name} version pin missing (set ${tool_name} pin)" >&2
    return 2
  fi
  if [[ "${version}" != v* ]]; then
    version="v${version}"
  fi

  require_cmd_or_blocked go || return $?

  local installed_version
  installed_version="$(go_tool_mod_version "${tool_name}" 2>/dev/null || true)"
  if [[ "${installed_version}" == "${version}" ]]; then
    return 0
  fi

  echo "Installing ${tool_name} ${version} into ${GOV_TOOLS_BIN}..." >&2
  if ! GOBIN="${GOV_TOOLS_BIN}" go install "${module_path}@${version}"; then
    echo "BLOCKED: failed to install pinned ${tool_name} ${version} (check network/toolchain)" >&2
    return 2
  fi

  installed_version="$(go_tool_mod_version "${tool_name}" 2>/dev/null || true)"
  if [[ "${installed_version}" != "${version}" ]]; then
    echo "FAIL: installed ${tool_name} does not match expected version ${version}" >&2
    go version -m "$(command -v "${tool_name}")" 2>/dev/null || true
    return 1
  fi

  return 0
}

ensure_govulncheck_pinned() {
  ensure_go_tool_pinned \
    "govulncheck" \
    "golang.org/x/vuln/cmd/govulncheck" \
    "${PIN_GOVULNCHECK_VERSION}"
}

ensure_osv_scanner_pinned() {
  ensure_go_tool_pinned \
    "osv-scanner" \
    "github.com/google/osv-scanner/cmd/osv-scanner" \
    "${PIN_OSV_SCANNER_VERSION}"
}

ensure_pip_audit_pinned() {
  local v="${PIN_PIP_AUDIT_VERSION}"
  if is_unset_token "${v}"; then
    echo "BLOCKED: pip-audit version pin missing (set PIN_PIP_AUDIT_VERSION)" >&2
    return 2
  fi

  require_cmd_or_blocked python3 || return $?

  local want="pip-audit ${v}"
  if [[ -x "${GOV_TOOLS_PY_BIN}/pip-audit" ]]; then
    if "${GOV_TOOLS_PY_BIN}/pip-audit" --version 2>/dev/null | grep -Fq "${want}"; then
      return 0
    fi
  fi

  rm -rf "${GOV_TOOLS_PY_DIR}"

  echo "Installing pip-audit ${v} into ${GOV_TOOLS_PY_DIR}..." >&2
  if ! python3 -m venv "${GOV_TOOLS_PY_DIR}"; then
    echo "BLOCKED: failed to create python venv at ${GOV_TOOLS_PY_DIR}" >&2
    return 2
  fi

  if ! "${GOV_TOOLS_PY_BIN}/python" -m pip install --disable-pip-version-check --no-cache-dir "pip-audit==${v}"; then
    echo "BLOCKED: failed to install pinned pip-audit ${v}" >&2
    return 2
  fi

  if ! "${GOV_TOOLS_PY_BIN}/pip-audit" --version 2>/dev/null | grep -Fq "${want}"; then
    echo "FAIL: installed pip-audit does not match expected version ${v}" >&2
    "${GOV_TOOLS_PY_BIN}/pip-audit" --version 2>/dev/null || true
    return 1
  fi

  return 0
}

ensure_cdk_dist_go_bindings_generated() {
  # Ensures the jsii-generated Go module exists under:
  #   cdk/dist/go/apptheorycdk
  #
  # Note: `cdk/dist/**` is ignored by git and should be generated deterministically
  # for checks that scan/compile it (COM-1, SEC-2, SEC-3).
  require_cmd_or_blocked go || return $?
  require_cmd_or_blocked node || return $?
  require_cmd_or_blocked npm || return $?

  if [[ ! -d "cdk" ]] || [[ ! -f "cdk/package-lock.json" ]]; then
    echo "FAIL: expected CDK project missing for Go binding generation" >&2
    return 1
  fi

  (cd cdk && npm ci >/dev/null)
  (cd cdk && npm run build >/dev/null)
  (cd cdk && npx jsii-pacmak -t go --code-only -o dist/go --force-subdirectory false --force >/dev/null)

  if [[ ! -f "cdk/dist/go/apptheorycdk/go.mod" ]]; then
    echo "FAIL: expected generated go.mod missing: cdk/dist/go/apptheorycdk/go.mod" >&2
    return 1
  fi

  # Pacmak output can require a tidy pass to ensure the module graph is complete.
  (cd cdk/dist/go/apptheorycdk && go mod tidy >/dev/null)

  return 0
}

read_py_runtime_deps() {
  # Reads Python runtime dependencies from py/pyproject.toml (one requirement per line).
  if [[ ! -f "${REPO_ROOT}/py/pyproject.toml" ]]; then
    echo "FAIL: missing Python pyproject: py/pyproject.toml" >&2
    return 1
  fi

  local deps
  deps="$(
    python3 - <<'PY'
from __future__ import annotations

import pathlib

try:
    import tomllib  # py311+
except Exception as exc:  # noqa: BLE001
    raise SystemExit(f"missing tomllib: {exc}")

p = pathlib.Path("py/pyproject.toml")
data = tomllib.loads(p.read_text(encoding="utf-8"))
deps = data.get("project", {}).get("dependencies", []) or []
for dep in deps:
    if str(dep).strip():
        print(dep)
PY
  )" || {
    echo "BLOCKED: failed to parse py/pyproject.toml (requires python>=3.11 with tomllib)" >&2
    return 2
  }

  printf '%s\n' "${deps}"
}

ensure_py_runtime_deps_installed_into() {
  # Installs pinned Python runtime deps into the interpreter's environment.
  local python_bin="$1"
  if [[ -z "${python_bin//[[:space:]]/}" ]] || [[ ! -x "${python_bin}" ]]; then
    echo "FAIL: expected python executable: ${python_bin}" >&2
    return 1
  fi

  local deps_raw
  deps_raw="$(read_py_runtime_deps)" || return $?

  local -a deps=()
  local dep
  while IFS= read -r dep; do
    [[ -n "${dep//[[:space:]]/}" ]] || continue
    if [[ "${dep}" != *"=="* ]] && [[ "${dep}" != *"@"* ]]; then
      echo "BLOCKED: unpinned Python runtime dependency: ${dep}" >&2
      return 2
    fi
    deps+=("${dep}")
  done <<< "${deps_raw}"

  local venv_dir
  venv_dir="$(cd "$(dirname "${python_bin}")/.." && pwd)"
  local stamp="${venv_dir}/.gov-py-runtime-deps.txt"
  local want
  want="$(printf '%s\n' "${deps[@]}")"

  if [[ -f "${stamp}" ]]; then
    local have
    have="$(cat "${stamp}" 2>/dev/null || true)"
    if [[ "${have}" == "${want}" ]]; then
      return 0
    fi
  fi

  if [[ "${#deps[@]}" -gt 0 ]]; then
    echo "Installing Python runtime deps into ${venv_dir}..." >&2
    if ! "${python_bin}" -m pip install --disable-pip-version-check --no-cache-dir "${deps[@]}"; then
      echo "BLOCKED: failed to install Python runtime dependencies (check network/toolchain)" >&2
      return 2
    fi
  fi

  printf '%s\n' "${deps[@]}" > "${stamp}"
  return 0
}

ensure_py_runtime_deps_installed() {
  require_cmd_or_blocked python3 || return $?

  if [[ -x "${GOV_TOOLS_PY_RUNTIME_BIN}/python" ]]; then
    ensure_py_runtime_deps_installed_into "${GOV_TOOLS_PY_RUNTIME_BIN}/python" && return 0
  fi

  rm -rf "${GOV_TOOLS_PY_RUNTIME_DIR}"
  echo "Creating Python runtime venv at ${GOV_TOOLS_PY_RUNTIME_DIR}..." >&2
  if ! python3 -m venv "${GOV_TOOLS_PY_RUNTIME_DIR}"; then
    echo "BLOCKED: failed to create python venv at ${GOV_TOOLS_PY_RUNTIME_DIR}" >&2
    return 2
  fi

  ensure_py_runtime_deps_installed_into "${GOV_TOOLS_PY_RUNTIME_BIN}/python"
}

# --- Repo-specific verifiers (functions called by CMD_* below) ---

gov_cmd_unit() {
  require_cmd_or_blocked go || return $?
  require_cmd_or_blocked node || return $?
  require_cmd_or_blocked python3 || return $?

  make test-unit

  node --test contract-tests/runners/ts/fixtures.test.cjs
  ensure_py_runtime_deps_installed || return $?
  "${GOV_TOOLS_PY_RUNTIME_BIN}/python" contract-tests/runners/py/run.py
  PYTHONPATH="${REPO_ROOT}/py/src" "${GOV_TOOLS_PY_RUNTIME_BIN}/python" -m unittest discover -s py/tests -p "test_*.py"
}

gov_cmd_integration() {
  require_cmd_or_blocked node || return $?
  require_cmd_or_blocked npm || return $?
  require_cmd_or_blocked python3 || return $?
  scripts/verify-testkit-examples.sh
}

gov_cmd_fmt() {
  require_cmd_or_blocked gofmt || return $?
  make fmt-check
}

gov_cmd_lint() {
  require_cmd_or_blocked go || return $?
  require_cmd_or_blocked node || return $?
  require_cmd_or_blocked npm || return $?
  require_cmd_or_blocked python3 || return $?

  # Ensure pinned golangci-lint is present so `scripts/verify-go-lint.sh` does not require a global install.
  ensure_golangci_lint_pinned || return $?

  make lint
}

gov_cmd_contract() {
  require_cmd_or_blocked go || return $?
  require_cmd_or_blocked node || return $?
  require_cmd_or_blocked python3 || return $?
  scripts/verify-contract-tests.sh
}

gov_cmd_sast() {
  require_cmd_or_blocked go || return $?
  ensure_golangci_lint_pinned || return $?
  scripts/verify-go-lint.sh
}

gov_cmd_vuln() {
  require_cmd_or_blocked go || return $?
  require_cmd_or_blocked node || return $?
  require_cmd_or_blocked npm || return $?
  require_cmd_or_blocked python3 || return $?

  ensure_govulncheck_pinned || return $?
  ensure_osv_scanner_pinned || return $?
  ensure_pip_audit_pinned || return $?

  ensure_cdk_dist_go_bindings_generated || return $?

  local -a go_mod_dirs=(
    "."
    "cdk/dist/go/apptheorycdk"
  )

  local d
  for d in "${go_mod_dirs[@]}"; do
    if [[ ! -f "${d}/go.mod" ]]; then
      echo "FAIL: expected go.mod missing: ${d}/go.mod" >&2
      return 1
    fi

    echo "==> govulncheck: ${d}"
    (cd "${d}" && govulncheck ./...)
  done

  local -a node_lockfiles=(
    "ts/package-lock.json"
    "cdk/package-lock.json"
    "examples/cdk/multilang/package-lock.json"
    "examples/cdk/ssr-site/package-lock.json"
  )

  local lf
  for lf in "${node_lockfiles[@]}"; do
    if [[ ! -f "${lf}" ]]; then
      echo "FAIL: expected Node lockfile missing: ${lf}" >&2
      return 1
    fi

    echo "==> osv-scanner (Node): ${lf}"
    osv-scanner scan --lockfile="${lf}"
  done

  local -a py_requirements=(
    "py/requirements-build.txt"
    "py/requirements-lint.txt"
  )

  local req
  local -a pip_audit_args=()
  for req in "${py_requirements[@]}"; do
    if [[ ! -f "${req}" ]]; then
      echo "FAIL: expected Python requirements file missing: ${req}" >&2
      return 1
    fi
    pip_audit_args+=("-r" "${req}")
  done

  echo "==> pip-audit (Python): ${py_requirements[*]}"
  pip-audit "${pip_audit_args[@]}"

  echo "vuln-scans: PASS"
}

gov_cmd_p0() {
  # Treat deterministic builds as a P0 integrity gate.
  require_cmd_or_blocked git || return $?
  require_cmd_or_blocked go || return $?
  require_cmd_or_blocked node || return $?
  require_cmd_or_blocked npm || return $?
  require_cmd_or_blocked python3 || return $?

  ensure_golangci_lint_pinned || return $?

  scripts/verify-builds.sh
}

check_multi_module_health() {
  require_cmd_or_blocked go || return $?
  require_cmd_or_blocked node || return $?
  require_cmd_or_blocked npm || return $?

  echo "Multi-module health: root module (go test ./...)"
  go test -buildvcs=false ./...

  ensure_cdk_dist_go_bindings_generated || return $?

  local -a mods=(
    "cdk/dist/go/apptheorycdk"
  )

  local d
  for d in "${mods[@]}"; do
    if [[ ! -d "${d}" ]]; then
      echo "FAIL: expected module directory missing: ${d}" >&2
      return 1
    fi
    if [[ ! -f "${d}/go.mod" ]]; then
      echo "FAIL: expected go.mod missing: ${d}/go.mod" >&2
      return 1
    fi
    echo "Multi-module health: ${d} (go test ./...)"
    (cd "${d}" && go test -buildvcs=false ./...)
  done

  echo "multi-module: PASS"
}

check_toolchain_pins() {
  # Verifies that pinned toolchain versions agree between:
  # - go.mod toolchain/go version
  # - GitHub Actions workflow pins

  local wf="${REPO_ROOT}/.github/workflows/ci.yml"
  if [[ ! -f "${wf}" ]]; then
    echo "BLOCKED: missing workflow: ${wf}" >&2
    return 2
  fi

  local go_toolchain
  go_toolchain="$(awk '/^toolchain[[:space:]]+/{print $2; exit}' go.mod 2>/dev/null || true)"
  if [[ -z "${go_toolchain}" ]]; then
    echo "FAIL: go.mod missing toolchain directive" >&2
    return 1
  fi

  local go_version="${go_toolchain#go}"

  echo "Expected pins (from repo):"
  echo "- Go toolchain: ${go_toolchain}"
  echo "- Node: 24"
  echo "- Python: 3.14"
  echo "- golangci-lint: ${PIN_GOLANGCI_LINT_VERSION}"

  # Go pin in CI
  if ! grep -Eq "go-version:[[:space:]]*\"${go_version}\"" "${wf}"; then
    echo "FAIL: ci.yml does not pin go-version to ${go_version}" >&2
    grep -n "go-version" "${wf}" || true
    return 1
  fi

  # Node pin in CI
  if ! grep -Eq "node-version:[[:space:]]*\"24\"" "${wf}"; then
    echo "FAIL: ci.yml does not pin node-version to 24" >&2
    grep -n "node-version" "${wf}" || true
    return 1
  fi

  # Python pin in CI
  if ! grep -Eq "python-version:[[:space:]]*\"3\.14\"" "${wf}"; then
    echo "FAIL: ci.yml does not pin python-version to 3.14" >&2
    grep -n "python-version" "${wf}" || true
    return 1
  fi

  # golangci-lint pin (string check; the repo installs via `go install ...@v2.8.0`)
  if ! grep -Eq "golangci-lint.*/v2/cmd/golangci-lint@${PIN_GOLANGCI_LINT_VERSION}" "${wf}"; then
    echo "FAIL: ci.yml does not pin golangci-lint to ${PIN_GOLANGCI_LINT_VERSION}" >&2
    grep -n "golangci-lint" "${wf}" || true
    return 1
  fi

  echo "toolchain-pins: PASS"
}

check_lint_config_valid() {
  # We treat "config validity" as: the pinned golangci-lint successfully parses the config and runs.
  # This check does NOT enforce issue-free output; CON-2 enforces that.

  require_cmd_or_blocked go || return $?
  ensure_golangci_lint_pinned || return $?

  if [[ ! -f ".golangci-v2.yml" ]]; then
    echo "FAIL: missing .golangci-v2.yml" >&2
    return 1
  fi

  echo "Validating golangci-lint config parseability (.golangci-v2.yml)"
  golangci-lint run --timeout=5m --config .golangci-v2.yml --issues-exit-code=0 ./...

  echo "lint-config: PASS"
}

check_coverage_threshold_floor() {
  # Anti-drift: ensure the declared rubric threshold does not silently drop below the target.

  if [[ "${COV_THRESHOLD}" -lt 90 ]]; then
    echo "FAIL: verifier coverage threshold (${COV_THRESHOLD}) is below the required floor (90)" >&2
    return 1
  fi

  local rubric="${PLANNING_DIR}/apptheory-10of10-rubric.md"
  if [[ ! -f "${rubric}" ]]; then
    echo "FAIL: missing rubric: ${rubric}" >&2
    return 1
  fi

  if ! grep -q "Coverage ≥ 90%" "${rubric}"; then
    echo "FAIL: rubric does not declare 'Coverage ≥ 90%' (anti-drift)" >&2
    return 1
  fi

  echo "coverage-threshold-floor: PASS (threshold=${COV_THRESHOLD}%)"
}

check_go_coverage() {
  # Produces:
  # - gov-infra/evidence/go-coverage.out
  # - gov-infra/evidence/go-coverage-summary.txt
  # and enforces total coverage >= COV_THRESHOLD.

  require_cmd_or_blocked go || return $?

  local cover_out="${EVIDENCE_DIR}/go-coverage.out"
  local summary="${EVIDENCE_DIR}/go-coverage-summary.txt"

  rm -f "${cover_out}" "${summary}"

  echo "Generating Go coverage profile..."
  # We exclude generated CDK Go bindings from coverage math to avoid diluting runtime coverage.
  # These bindings are compile-checked elsewhere (COM-1) but are not meaningful to unit test.
  mapfile -t pkgs < <(go list ./... | grep -v '/cdk-go/')
  if [[ "${#pkgs[@]}" -eq 0 ]]; then
    echo "FAIL: no Go packages selected for coverage run" >&2
    return 1
  fi
  if ! go test -buildvcs=false "${pkgs[@]}" -coverprofile="${cover_out}"; then
    echo "FAIL: go tests failed during coverage run" >&2
    return 1
  fi

  if [[ ! -f "${cover_out}" ]]; then
    echo "FAIL: missing coverage profile output: ${cover_out}" >&2
    return 1
  fi

  echo "Computing total coverage..."
  local total_line
  total_line="$(go tool cover -func="${cover_out}" | tail -n 1)"

  echo "${total_line}" | tee "${summary}"

  local pct
  pct="$(printf '%s' "${total_line}" | awk '{print $3}' | tr -d '%')"
  if [[ -z "${pct}" ]]; then
    echo "FAIL: unable to parse coverage percentage from: ${total_line}" >&2
    return 1
  fi

  # Compare as decimal using awk (do not rely on `set -e`, since callers may run with `set +e`).
  if ! awk -v pct="${pct}" -v thr="${COV_THRESHOLD}" 'BEGIN { if (pct+0 < thr+0) exit 1; exit 0 }'; then
    echo "FAIL: coverage below threshold (${pct}% < ${COV_THRESHOLD}%)" >&2
    return 1
  fi

  echo "coverage: PASS (${pct}% >= ${COV_THRESHOLD}%)"
}

ensure_py_coverage_pinned() {
  # Install a pinned Coverage.py into a dedicated venv under gov-infra/.tools/.
  require_cmd_or_blocked python3 || return $?

  local v="${PIN_PY_COVERAGE_VERSION}"
  local want="Coverage.py, version ${v}"

  if [[ -x "${GOV_TOOLS_PY_COV_BIN}/coverage" ]]; then
    if "${GOV_TOOLS_PY_COV_BIN}/coverage" --version 2>/dev/null | grep -Fq "${want}"; then
      return 0
    fi
  fi

  rm -rf "${GOV_TOOLS_PY_COV_DIR}"
  echo "Installing Coverage.py ${v} into ${GOV_TOOLS_PY_COV_DIR}..." >&2
  if ! python3 -m venv "${GOV_TOOLS_PY_COV_DIR}"; then
    echo "BLOCKED: failed to create python venv at ${GOV_TOOLS_PY_COV_DIR}" >&2
    return 2
  fi
  if ! "${GOV_TOOLS_PY_COV_BIN}/python" -m pip install --disable-pip-version-check --no-cache-dir "coverage==${v}"; then
    echo "BLOCKED: failed to install pinned Coverage.py ${v}" >&2
    return 2
  fi

  if ! "${GOV_TOOLS_PY_COV_BIN}/coverage" --version 2>/dev/null | grep -Fq "${want}"; then
    echo "FAIL: installed Coverage.py does not match expected version ${v}" >&2
    "${GOV_TOOLS_PY_COV_BIN}/coverage" --version 2>/dev/null || true
    return 1
  fi

  return 0
}

check_ts_coverage() {
  # Enforces TypeScript runtime coverage >= COV_THRESHOLD for the shipped JS under ts/dist/.
  # Primary driver: contract fixtures (same semantics as CON-3), but measured against ts/dist/**.
  require_cmd_or_blocked node || return $?

  local summary="${EVIDENCE_DIR}/ts-coverage-summary.txt"
  rm -f "${summary}"

  if [[ ! -f "ts/dist/index.js" ]]; then
    echo "FAIL: missing TypeScript dist entrypoint: ts/dist/index.js" >&2
    return 1
  fi

  local test_file="contract-tests/runners/ts/fixtures.test.cjs"
  if [[ ! -f "${test_file}" ]]; then
    echo "FAIL: missing TS coverage test driver: ${test_file}" >&2
    return 1
  fi

  local tmp
  tmp="$(mktemp)"

  # Notes:
  # - Coverage thresholds are enforced by Node itself (no external coverage toolchain).
  # - We include only shipped runtime output under ts/dist/** to prevent denominator games.
  if ! NO_COLOR=1 node --test --experimental-test-coverage \
    --test-coverage-lines="${COV_THRESHOLD}" \
    --test-coverage-include="ts/dist/**/*.js" \
    "${test_file}" >"${tmp}" 2>&1; then
    cat "${tmp}"
    if grep -i -F "all files" "${tmp}" > "${summary}"; then :; else tail -n 80 "${tmp}" > "${summary}"; fi
    rm -f "${tmp}"
    return 1
  fi

  cat "${tmp}"
  if grep -i -F "all files" "${tmp}" > "${summary}"; then :; else tail -n 80 "${tmp}" > "${summary}"; fi
  rm -f "${tmp}"
  echo "ts-coverage: PASS (see ${summary})"
}

check_py_coverage() {
  # Enforces Python runtime coverage >= COV_THRESHOLD for the shipped package under py/src/apptheory/.
  # Primary driver: contract fixtures (same semantics as CON-3), but measured against py/src/apptheory/**.
  require_cmd_or_blocked python3 || return $?
  ensure_py_coverage_pinned || return $?
  ensure_py_runtime_deps_installed_into "${GOV_TOOLS_PY_COV_BIN}/python" || return $?

  local summary="${EVIDENCE_DIR}/py-coverage-summary.txt"
  local data="${EVIDENCE_DIR}/py-coverage.data"
  rm -f "${summary}" "${data}"

  if [[ ! -d "py/src/apptheory" ]]; then
    echo "FAIL: missing Python runtime source dir: py/src/apptheory" >&2
    return 1
  fi
  if [[ ! -f "contract-tests/runners/py/run.py" ]]; then
    echo "FAIL: missing Python contract runner: contract-tests/runners/py/run.py" >&2
    return 1
  fi

  local src_dir="${REPO_ROOT}/py/src/apptheory"
  if ! PYTHONPATH="${REPO_ROOT}/py/src" COVERAGE_FILE="${data}" "${GOV_TOOLS_PY_COV_BIN}/python" -m coverage run \
    --source="${src_dir}" \
    contract-tests/runners/py/run.py; then
    echo "FAIL: python coverage run failed" >&2
    return 1
  fi

  if ! PYTHONPATH="${REPO_ROOT}/py/src" COVERAGE_FILE="${data}" "${GOV_TOOLS_PY_COV_BIN}/python" -m coverage run \
    --append \
    --source="${src_dir}" \
    -m unittest discover -s py/tests -p "test_*.py"; then
    echo "FAIL: python unit tests failed during coverage run" >&2
    return 1
  fi

  if ! COVERAGE_FILE="${data}" "${GOV_TOOLS_PY_COV_BIN}/python" -m coverage report \
    --fail-under="${COV_THRESHOLD}" \
    --precision=1 > "${summary}" 2>&1; then
    cat "${summary}" || true
    echo "FAIL: python coverage below threshold (${COV_THRESHOLD}%)" >&2
    return 1
  fi

  cat "${summary}"
  echo "py-coverage: PASS (see ${summary})"
}

check_coverage() {
  # Multi-language coverage gate (Go/TypeScript/Python).
  local fail=0
  local blocked=0

  echo "==> coverage: Go"
  set +e
  check_go_coverage
  local ec_go=$?
  set -e
  if [[ $ec_go -eq 2 ]]; then
    blocked=1
  elif [[ $ec_go -ne 0 ]]; then
    fail=1
  fi

  echo ""
  echo "==> coverage: TypeScript"
  set +e
  check_ts_coverage
  local ec_ts=$?
  set -e
  if [[ $ec_ts -eq 2 ]]; then
    blocked=1
  elif [[ $ec_ts -ne 0 ]]; then
    fail=1
  fi

  echo ""
  echo "==> coverage: Python"
  set +e
  check_py_coverage
  local ec_py=$?
  set -e
  if [[ $ec_py -eq 2 ]]; then
    blocked=1
  elif [[ $ec_py -ne 0 ]]; then
    fail=1
  fi

  if [[ "${fail}" -ne 0 ]]; then
    return 1
  fi
  if [[ "${blocked}" -ne 0 ]]; then
    return 2
  fi
  return 0
}

check_security_config() {
  # Anti-drift: ensure security linters remain enabled and are not broadly excluded.
  local cfg="${REPO_ROOT}/.golangci-v2.yml"
  if [[ ! -f "${cfg}" ]]; then
    echo "FAIL: missing ${cfg}" >&2
    return 1
  fi

  grep -Eq '^[[:space:]]*- gosec[[:space:]]*$' "${cfg}" || {
    echo "FAIL: .golangci-v2.yml does not enable 'gosec'" >&2
    return 1
  }

  # Fail closed if the config disables all linters.
  if grep -Eq '^[[:space:]]*disable-all:[[:space:]]*true' "${cfg}"; then
    echo "FAIL: .golangci-v2.yml sets disable-all: true (not allowed)" >&2
    return 1
  fi

  # Minimal guardrail: do not allow a large number of gosec excludes without review.
  # Current repo config excludes only G104; allowing up to 3 keeps the gate strict.
  local exclude_count
  exclude_count="$(awk '
    $1=="gosec:" {ing=1}
    ing && $1=="excludes:" {inex=1; next}
    ing && inex {
      if ($1 ~ /^-/) c++
      # stop when leaving gosec block (heuristic)
      if ($1 ~ /^[^[:space:]]/ && $1 != "gosec:") {ing=0; inex=0}
    }
    END {print c+0}
  ' "${cfg}")"

  echo "gosec excludes count: ${exclude_count}"
  if [[ "${exclude_count}" -gt 3 ]]; then
    echo "FAIL: too many gosec excludes (${exclude_count}); justify and narrow" >&2
    return 1
  fi

  echo "security-config: PASS"
}

check_logging_ops_standards() {
  # COM-6: logging/operational standards enforced (deterministic).
  #
  # AppTheory is a framework/runtime with multi-language surfaces. For the Go
  # implementation, enforce:
  # - explicit, versioned standards doc
  # - no stdout / stdlib logging in in-scope framework code
  # - operational tests validating sanitization/redaction

  local standards="${PLANNING_DIR}/apptheory-logging-ops-standards.md"
  if [[ ! -f "${standards}" ]]; then
    echo "BLOCKED: missing logging/ops standards doc: ${standards}" >&2
    return 2
  fi

  local missing=0
  for heading in \
    "## Scope" \
    "## Allowed patterns" \
    "## Prohibited patterns" \
    "## Tests (operational standards)"; do
    if ! grep -Fq "${heading}" "${standards}"; then
      echo "FAIL: logging/ops standards missing required heading: ${heading}" >&2
      missing=1
    fi
  done

  if [[ "${missing}" -ne 0 ]]; then
    return 1
  fi

  if ! command -v git >/dev/null 2>&1; then
    echo "BLOCKED: git is required to deterministically enumerate in-scope files" >&2
    return 2
  fi

  local files
  files="$(
    git ls-files '*.go' \
      ':!:vendor/**' \
      ':!:**/node_modules/**' \
      ':!:**/dist/**' \
      ':!:**/build/**' \
      ':!:**/third_party/**' \
      ':!:**/testdata/**' \
      | grep -vE '^(examples/|testkit/|contract-tests/|gov-infra/)' \
      | grep -vE '_test[.]go$' \
      || true
  )"

  if [[ -z "${files}" ]]; then
    echo "FAIL: no in-scope Go files found for logging policy scan" >&2
    return 1
  fi

  local hits
  hits="$(
    printf '%s\n' "${files}" \
      | xargs -r grep -nE \
        '\\bfmt\\.(Print|Printf|Println)\\b|\\bprint(ln)?\\s*\\(|\\blog\\.Print(ln|f)?\\b|\\blog\\.(Fatal|Fatalln|Fatalf|Panic|Panicln|Panicf)\\b' \
      || true
  )"

  if [[ -n "${hits}" ]]; then
    echo "FAIL: prohibited logging/printing patterns found in in-scope code:" >&2
    echo "${hits}" >&2
    return 1
  fi

  require_cmd_or_blocked go || return $?

  local -a pkgs=(
    "./pkg/observability/zap"
    "./pkg/observability"
  )

  local listed
  listed="$(go test -list '^TestOps_' "${pkgs[@]}" 2>/dev/null | grep -E '^TestOps_' || true)"
  if [[ -z "${listed}" ]]; then
    echo "FAIL: no operational standards tests found (expected TestOps_* in: ${pkgs[*]})" >&2
    return 1
  fi

  go test -count=1 -run '^TestOps_' "${pkgs[@]}"

  echo "logging-ops: PASS"
  return 0
}

check_doc_integrity() {
  # Ensures governance docs are rendered (no leftover template tokens) and pack metadata is consistent.

  # Only scan governance artifacts (exclude verifier code, generated evidence, and pinned tools).
  if grep -R --line-number --binary-files=without-match \
    --exclude-dir="evidence" \
    --exclude-dir="verifiers" \
    --exclude-dir=".tools" \
    "{{" "${GOV_INFRA}" >/dev/null 2>&1; then
    echo "FAIL: found unrendered template token(s) under gov-infra/" >&2
    grep -R --line-number --binary-files=without-match \
      --exclude-dir="evidence" \
      --exclude-dir="verifiers" \
      --exclude-dir=".tools" \
      "{{" "${GOV_INFRA}" || true
    return 1
  fi

  local pack="${GOV_INFRA}/pack.json"
  if [[ ! -f "${pack}" ]]; then
    echo "FAIL: missing pack.json" >&2
    return 1
  fi

  grep -q '"packDigest": "22406dbb1031ebc4dcd83e02912bbc307ab0983629463aa6106b76415e6280af"' "${pack}" || {
    echo "FAIL: pack.json packDigest mismatch" >&2
    return 1
  }
  grep -q '"packVersion": "2ba585f48951"' "${pack}" || {
    echo "FAIL: pack.json packVersion mismatch" >&2
    return 1
  }
  grep -q '"projectSlug": "apptheory"' "${pack}" || {
    echo "FAIL: pack.json projectSlug mismatch" >&2
    return 1
  }

  echo "doc-integrity: PASS"
}

check_docs_standard() {
  # Ensures shipped packages follow the Pay Theory documentation standard (docs file set + YAML triad).
  bash ./scripts/verify-docs-standard.sh
}

check_file_budgets() {
  # Maintainability heuristic: prevent "god files" from growing unchecked.
  # This is intentionally simple and deterministic.

  local max_go_lines=2000

  # Avoid scanning vendored/generated caches; keep deterministic signal.
  local tmp
  tmp="$(mktemp)"
  trap 'rm -f "${tmp}"' RETURN

  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files '*.go' \
      ':!:vendor/**' \
      ':!:**/node_modules/**' \
      ':!:**/dist/**' \
      ':!:**/build/**' \
      ':!:**/third_party/**' \
      ':!:**/testdata/**' \
      > "${tmp}"
  else
    find . -name '*.go' -type f \
      -not -path './vendor/*' \
      -not -path './node_modules/*' \
      -not -path './dist/*' \
      -not -path './build/*' \
      -not -path './third_party/*' \
      -not -path './testdata/*' \
      > "${tmp}"
  fi

  if [[ ! -s "${tmp}" ]]; then
    echo "file-budgets: PASS (no Go files)"
    return 0
  fi

  local worst_lines=0
  local worst_file=""

  local f
  while IFS= read -r f; do
    [[ -f "${f}" ]] || continue
    local n
    n="$(wc -l < "${f}" | tr -d ' ')"
    if [[ "${n}" -gt "${worst_lines}" ]]; then
      worst_lines="${n}"
      worst_file="${f}"
    fi
    if [[ "${n}" -gt "${max_go_lines}" ]]; then
      echo "FAIL: Go file exceeds budget (${max_go_lines} lines): ${f} (${n} lines)" >&2
      return 1
    fi
  done < "${tmp}"

  echo "file-budgets: PASS (max_go_lines=${max_go_lines}; worst=${worst_file}:${worst_lines})"
}

check_maintainability_roadmap() {
  local roadmap="${PLANNING_DIR}/apptheory-10of10-roadmap.md"
  if [[ ! -f "${roadmap}" ]]; then
    echo "FAIL: missing roadmap: ${roadmap}" >&2
    return 1
  fi

  local rubric="${PLANNING_DIR}/apptheory-10of10-rubric.md"
  if [[ ! -f "${rubric}" ]]; then
    echo "FAIL: missing rubric: ${rubric}" >&2
    return 1
  fi

  local rubric_version=""
  rubric_version="$(awk -F'`' '/\\*\\*Rubric version:\\*\\*/ {print $2; exit}' "${rubric}" 2>/dev/null || true)"
  if [[ -z "${rubric_version}" ]]; then
    echo "FAIL: could not parse rubric version from ${rubric}" >&2
    return 1
  fi

  grep -q "Rubric ${rubric_version}" "${roadmap}" || {
    echo "FAIL: roadmap does not reference current rubric version (${rubric_version})" >&2
    return 1
  }
  echo "maintainability-roadmap: PASS"
}

check_duplicate_semantics() {
  # MAI-3: canonical implementations / duplicate semantics (heuristic initial gate).
  #
  # Enforce duplicate detection for Go code using the `dupl` linter under the
  # pinned golangci-lint toolchain. This is intentionally narrow and can be
  # expanded later to additional languages/semantics as the pack evolves.

  require_cmd_or_blocked go || return $?
  ensure_golangci_lint_pinned || return $?

  local cfg="${REPO_ROOT}/.golangci-v2.yml"
  if [[ ! -f "${cfg}" ]]; then
    echo "FAIL: missing ${cfg}" >&2
    return 1
  fi

  grep -Eq '^[[:space:]]*- dupl[[:space:]]*$' "${cfg}" || {
    echo "FAIL: ${cfg} does not enable 'dupl' (required for MAI-3)" >&2
    return 1
  }

  if [[ ! -f "./go.mod" ]]; then
    echo "FAIL: expected go.mod missing: ./go.mod" >&2
    return 1
  fi

  # Scope note: we intentionally scan only the root Go module. CDK Go bindings
  # under cdk-go/ are jsii-generated and contain large, mechanical duplication
  # that would drown out meaningful signal for this gate.
  echo "==> dupl scan: ."
  golangci-lint run --timeout=5m --config "${cfg}" --enable-only=dupl ./...

  echo "duplicate-semantics: PASS"
  return 0
}

# --- Supply-chain checks (SEC-3) ---

allowlist_has_id() {
  local allowlist_path="$1"
  local id="$2"
  [[ -f "${allowlist_path}" ]] || return 1
  grep -Fqx -- "${id}" "${allowlist_path}"
}

sha256_12() {
  local s="$1"
  local hash=""
  if command -v sha256sum >/dev/null 2>&1; then
    hash="$(printf '%s' "${s}" | sha256sum | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    hash="$(printf '%s' "${s}" | shasum -a 256 | awk '{print $1}')"
  else
    echo "BLOCKED: sha256 tool missing (need sha256sum or shasum)" >&2
    return 2
  fi
  printf '%s' "${hash:0:12}"
  return 0
}

check_supply_chain_actions_pinned() {
  # Enforces integrity pinning for GitHub Actions.
  # Requirements:
  # - No floating tags like @v4
  # - All remote actions pinned by full commit SHA (40 hex chars)
  local wf_dir="${REPO_ROOT}/.github/workflows"
  if [[ ! -d "${wf_dir}" ]]; then
    echo "GitHub Actions pin check: no workflows detected; skipping."
    return 0
  fi

  local failures=0

  local line
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue

    local loc="${line%%:*}"
    local rest="${line#*:}"
    local lineno="${rest%%:*}"
    local content="${rest#*:}"

    local spec
    spec="$(printf '%s' "${content}" | sed -E 's/^[[:space:]]*-?[[:space:]]*uses:[[:space:]]*//; s/[[:space:]]*#.*$//; s/[[:space:]]+$//')"
    [[ -z "${spec}" ]] && continue

    # Local actions do not require pinning.
    if [[ "${spec}" == ./* || "${spec}" == ../* ]]; then
      continue
    fi

    # Docker actions are handled separately (digest pinning), out-of-scope for now.
    if [[ "${spec}" == docker://* ]]; then
      continue
    fi

    if [[ "${spec}" != *"@"* ]]; then
      echo "FAIL: GitHub Action missing ref pin: ${loc}:${lineno}: ${spec}"
      failures=$((failures + 1))
      continue
    fi

    local ref="${spec##*@}"

    if [[ ! "${ref}" =~ ^[0-9a-fA-F]{40}$ ]]; then
      echo "FAIL: GitHub Action not pinned by commit SHA (expected 40 hex): ${loc}:${lineno}: ${spec}"
      failures=$((failures + 1))
      continue
    fi
  done < <(grep -R --include='*.yml' --include='*.yaml' -nE '^[[:space:]]*-?[[:space:]]*uses:[[:space:]]*[^#[:space:]]+' "${wf_dir}" 2>/dev/null || true)

  if [[ "${failures}" -ne 0 ]]; then
    return 1
  fi

  echo "GitHub Actions pin check: PASS (all remote uses pinned by commit SHA)"
  return 0
}

install_node_deps_ignore_scripts_in_dir() {
  local dir="$1"

  require_cmd_or_blocked node || return $?
  require_cmd_or_blocked npm || return $?

  if [[ ! -f "${dir}/package.json" ]]; then
    echo "FAIL: missing ${dir}/package.json" >&2
    return 1
  fi
  if [[ ! -f "${dir}/package-lock.json" ]] && [[ ! -f "${dir}/npm-shrinkwrap.json" ]]; then
    echo "FAIL: missing npm lockfile in ${dir} (package-lock.json or npm-shrinkwrap.json)" >&2
    return 1
  fi

  (cd "${dir}" && npm ci --ignore-scripts --no-audit --no-fund)
}

scan_node_modules_supply_chain_in_dir() {
  local base_dir="$1"
  local allowlist_path="$2"

  if [[ ! -d "${base_dir}/node_modules" ]]; then
    echo "BLOCKED: node_modules/ not found in ${base_dir} (install step did not produce it)" >&2
    return 2
  fi
  require_cmd_or_blocked node || return $?

  local pkg_json_list
  pkg_json_list="$(mktemp)"
  find "${base_dir}/node_modules" -type f -name package.json 2>/dev/null | LC_ALL=C sort > "${pkg_json_list}"

  if [[ ! -s "${pkg_json_list}" ]]; then
    echo "No dependency package.json files found under ${base_dir}/node_modules; nothing to scan."
    rm -f "${pkg_json_list}"
    return 0
  fi

  # Use a node inline scanner (same ID format as allowlist template).
  set +e
  ALLOWLIST_PATH="${allowlist_path}" node - "${pkg_json_list}" "${base_dir}" <<'__GOV_NODE_SUPPLY_SCAN__'
const fs = require('fs');
const path = require('path');

const pkgListPath = process.argv[2];
const baseDir = process.argv[3] || process.cwd();
const allowlistPath = process.env.ALLOWLIST_PATH || '';

function readAllowlist(p) {
  if (!p) return new Set();
  try {
    if (!fs.existsSync(p)) return new Set();
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    const ids = new Set();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      ids.add(trimmed);
    }
    return ids;
  } catch (e) {
    console.error(`BLOCKED: failed to read allowlist at ${p}: ${e.message}`);
    process.exit(2);
  }
}

function sanitizeValue(v) {
  return String(v ?? '').split('\n').join(' ').split('\r').join(' ').trim();
}

function makeId(parts) {
  const segs = [
    'GOV-SUPPLY',
    'NODE',
    parts.kind,
    `pkg=${sanitizeValue(parts.pkg)}`,
    `ver=${sanitizeValue(parts.ver)}`,
    `hook=${sanitizeValue(parts.hook)}`
  ];
  if (parts.kind === 'FILE') {
    segs.push(`file=${sanitizeValue(parts.file)}`);
  }
  if (parts.ioc) {
    segs.push(`ioc=${sanitizeValue(parts.ioc)}`);
  } else {
    segs.push(`rule=${sanitizeValue(parts.rule)}`);
  }
  return segs.join(':');
}

const allowlist = readAllowlist(allowlistPath);
const hooks = ['preinstall', 'install', 'postinstall', 'prepack', 'prepare', 'prepublishOnly'];

const patterns = [
  { id: 'CURL_PIPE_SHELL', re: /curl\s+[^|]*\|\s*(sh|bash)\b/i },
  { id: 'WGET_PIPE_SHELL', re: /wget\s+[^|]*\|\s*(sh|bash)\b/i },
  { id: 'EVAL', re: /\beval\s*\(/i },
  { id: 'FUNCTION_CONSTRUCTOR', re: /\bFunction\s*\(/i },
  { id: 'BASE64_DECODE', re: /\b(base64\s+(-d|--decode)|base64\.b64decode|Buffer\.from\([^)]*base64|atob\s*\(|b64decode)\b/i },
  { id: 'CRED_FILE_ACCESS', re: /(\.npmrc|\.netrc|\.pypirc|pip\.conf)\b/i },
  { id: 'TOKEN_ENV_ACCESS', re: /\b(NPM_TOKEN|GITHUB_TOKEN|AWS_SECRET|AWS_ACCESS_KEY_ID|GOOGLE_APPLICATION|PYPI_TOKEN|TWINE_PASSWORD)\b/i },
  { id: 'WEBHOOK_EXFIL', re: /\b(webhook\.site|pipedream\.net|requestbin|pastebin\.com|transfer\.sh)\b/i }
];

const iocs = [
  'shai-hulud',
  'shai_hulud',
  'Shai-Hulud Repository',
  'Shai-Hulud Migration',
  'webhook.site',
  'bb8ca5f6-4175-45d2-b042-fc9ebb8170b7'
].map(s => s.toLowerCase());

function listPackageJsonPaths(listFile) {
  try {
    return fs.readFileSync(listFile, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (e) {
    console.error(`BLOCKED: failed to read package.json path list: ${e.message}`);
    process.exit(2);
  }
}

function safeReadJson(p) {
  try {
    const txt = fs.readFileSync(p, 'utf8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function normalizeScript(s) {
  return String(s ?? '').split('\n').join(' ').split('\r').join(' ').trim();
}

function scanTextForIocs(text, add) {
  const lower = text.toLowerCase();
  for (const ioc of iocs) {
    if (lower.includes(ioc)) {
      add(ioc);
    }
  }
}

const findings = [];
let allowlisted = 0;
let scannedPackages = 0;

const pkgJsonPaths = listPackageJsonPaths(pkgListPath);
for (const pkgJsonPath of pkgJsonPaths) {
  const pkg = safeReadJson(pkgJsonPath);
  if (!pkg) continue;
  const pkgName = pkg.name || path.basename(path.dirname(pkgJsonPath));
  const pkgVer = pkg.version || '';
  const scripts = pkg.scripts || {};

  scannedPackages++;

  for (const hook of hooks) {
    const rawScript = scripts[hook];
    if (typeof rawScript !== 'string' || rawScript.trim() === '') continue;
    const script = normalizeScript(rawScript);

    for (const { id, re } of patterns) {
      if (re.test(script)) {
        const fid = makeId({ kind: 'SCRIPT', pkg: pkgName, ver: pkgVer, hook, rule: id });
        if (allowlist.has(fid)) {
          allowlisted++;
        } else {
          findings.push({ id: fid, pkg: pkgName, ver: pkgVer, hook, where: pkgJsonPath, detail: script, rule: id });
        }
      }
    }

    const iocHits = new Set();
    scanTextForIocs(script, (ioc) => iocHits.add(ioc));
    for (const ioc of Array.from(iocHits).sort()) {
      const fid = makeId({ kind: 'SCRIPT', pkg: pkgName, ver: pkgVer, hook, ioc });
      if (allowlist.has(fid)) {
        allowlisted++;
      } else {
        findings.push({ id: fid, pkg: pkgName, ver: pkgVer, hook, where: pkgJsonPath, detail: script, ioc });
      }
    }

    // If a lifecycle hook runs a JS file via `node`, scan that file too.
    const pkgDir = path.dirname(pkgJsonPath);
    const nodeFileRe = /(^|[;&|]\s*)node\s+([^\s;&|]+\.js)\b/gi;
    const fileCandidates = new Set();
    let m;
    while ((m = nodeFileRe.exec(script)) !== null) {
      let p = m[2] || '';
      p = p.replace(/^['\"]/, '').replace(/['\"]$/, '');
      if (!p) continue;
      const resolved = path.isAbsolute(p) ? p : path.resolve(pkgDir, p);
      fileCandidates.add(resolved);
    }

    for (const absPath of Array.from(fileCandidates).sort()) {
      try {
        if (!fs.existsSync(absPath)) continue;
        const st = fs.statSync(absPath);
        const rel = path.relative(pkgDir, absPath);

        if (st.size > 1000000) {
          const fid = makeId({ kind: 'FILE', pkg: pkgName, ver: pkgVer, hook, file: rel, rule: 'LARGE_LIFECYCLE_SCRIPT' });
          if (allowlist.has(fid)) {
            allowlisted++;
          } else {
            findings.push({ id: fid, pkg: pkgName, ver: pkgVer, hook, where: absPath, detail: `${rel} (${st.size} bytes)`, rule: 'LARGE_LIFECYCLE_SCRIPT' });
          }
        }

        if (st.size <= 5000000) {
          const content = fs.readFileSync(absPath, 'utf8');
          const contentNorm = normalizeScript(content);

          const fileIocs = new Set();
          scanTextForIocs(contentNorm, (ioc) => fileIocs.add(ioc));
          for (const ioc of Array.from(fileIocs).sort()) {
            const fid = makeId({ kind: 'FILE', pkg: pkgName, ver: pkgVer, hook, file: rel, ioc });
            if (allowlist.has(fid)) {
              allowlisted++;
            } else {
              findings.push({ id: fid, pkg: pkgName, ver: pkgVer, hook, where: absPath, detail: rel, ioc });
            }
          }

          for (const { id, re } of patterns) {
            if (re.test(contentNorm)) {
              const fid = makeId({ kind: 'FILE', pkg: pkgName, ver: pkgVer, hook, file: rel, rule: id });
              if (allowlist.has(fid)) {
                allowlisted++;
              } else {
                findings.push({ id: fid, pkg: pkgName, ver: pkgVer, hook, where: absPath, detail: rel, rule: id });
              }
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }
}

findings.sort((a, b) => a.id.localeCompare(b.id));

console.log(`Supply-chain scan (Node): baseDir=${baseDir} scannedPackages=${scannedPackages} findings=${findings.length} allowlisted=${allowlisted}`);
if (allowlistPath) {
  console.log(`Allowlist: ${allowlistPath} (entries=${allowlist.size})`);
} else {
  console.log('Allowlist: (none)');
}

if (findings.length > 0) {
  console.log('');
  console.log('Findings (copy IDs into allowlist to suppress with justification):');
  for (const f of findings) {
    const loc = f.where ? ` where=${f.where}` : '';
    const extra = f.ioc ? ` ioc=${f.ioc}` : (f.rule ? ` rule=${f.rule}` : '');
    console.log(`- ${f.id}${extra}${loc}`);
    if (f.detail) {
      console.log(`  detail=${sanitizeValue(f.detail).slice(0, 200)}`);
    }
  }
  process.exit(1);
}

process.exit(0);
__GOV_NODE_SUPPLY_SCAN__
  local ec=$?
  set -e

  rm -f "${pkg_json_list}"

  if [[ $ec -eq 2 ]]; then
    return 2
  fi
  if [[ $ec -ne 0 ]]; then
    return 1
  fi
  return 0
}

extract_go_mod_replaces() {
  local mod="$1"
  [[ -f "${mod}" ]] || return 0

  awk '
    BEGIN { inblock=0 }
    $1 == "replace" && $2 == "(" { inblock=1; next }
    $1 == "replace" && $2 != "(" {
      $1=""; sub(/^[[:space:]]+/, ""); print; next
    }
    inblock && $1 == ")" { inblock=0; next }
    inblock { print; next }
  ' "${mod}"
}

scan_go_supply_chain_for_mod() {
  local go_mod_path="$1"
  local allowlist_path="$2"

  local mod_dir
  mod_dir="$(cd "$(dirname "${go_mod_path}")" && pwd)"

  local failures=0
  local allowlisted=0

  if [[ ! -f "${go_mod_path}" ]]; then
    echo "FAIL: missing go.mod at ${go_mod_path}" >&2
    return 1
  fi

  local go_sum_path="${mod_dir}/go.sum"
  if [[ ! -f "${go_sum_path}" ]]; then
    local id="GOV-SUPPLY:GO:MOD:rule=MISSING_GO_SUM:file=${go_sum_path#${REPO_ROOT}/}"
    if allowlist_has_id "${allowlist_path}" "${id}"; then
      allowlisted=$((allowlisted + 1))
    else
      failures=$((failures + 1))
      echo "- ${id}"
    fi
  fi

  local known_malicious=(
    "github.com/boltdb-go/bolt"
    "github.com/gin-goinc"
    "github.com/go-chi/chi/v6"
  )

  local mod
  for mod in "${known_malicious[@]}"; do
    if grep -Fq -- "${mod}" "${go_mod_path}" 2>/dev/null || ( [[ -f "${go_sum_path}" ]] && grep -Fq -- "${mod}" "${go_sum_path}" 2>/dev/null ); then
      local id="GOV-SUPPLY:GO:MOD:rule=KNOWN_MALICIOUS_MODULE:module=${mod}:file=${go_mod_path#${REPO_ROOT}/}"
      if allowlist_has_id "${allowlist_path}" "${id}"; then
        allowlisted=$((allowlisted + 1))
      else
        failures=$((failures + 1))
        echo "- ${id}"
      fi
    fi
  done

  local line
  while IFS= read -r line; do
    [[ -z "${line//[[:space:]]/}" ]] && continue
    [[ "${line}" == "//"* ]] && continue
    [[ "${line}" == *"=>"* ]] || continue

    local left="${line%%=>*}"
    local right="${line#*=>}"
    left="$(printf '%s' "${left}" | xargs)"
    right="$(printf '%s' "${right}" | xargs)"
    [[ -z "${left}" || -z "${right}" ]] && continue

    local from_mod=""
    local from_ver=""
    local to_mod=""
    local to_ver=""
    from_mod="$(printf '%s' "${left}" | awk '{print $1}')"
    from_ver="$(printf '%s' "${left}" | awk '{print $2}')"
    to_mod="$(printf '%s' "${right}" | awk '{print $1}')"
    to_ver="$(printf '%s' "${right}" | awk '{print $2}')"
    [[ -z "${from_mod}" || -z "${to_mod}" ]] && continue

    if [[ "${to_mod}" == ./* || "${to_mod}" == ../* || "${to_mod}" == /* ]]; then
      continue
    fi

    local from="${from_mod}@${from_ver:-_}"
    local to="${to_mod}@${to_ver:-_}"
    local id="GOV-SUPPLY:GO:REPLACE:rule=REMOTE_REPLACE:from=${from}:to=${to}:file=${go_mod_path#${REPO_ROOT}/}"
    if allowlist_has_id "${allowlist_path}" "${id}"; then
      allowlisted=$((allowlisted + 1))
    else
      failures=$((failures + 1))
      echo "- ${id} detail=$(printf '%s' "${line}" | tr -d '\r')"
    fi
  done < <(extract_go_mod_replaces "${go_mod_path}")

  echo "Supply-chain scan (Go): go.mod=${go_mod_path#${REPO_ROOT}/} findings=${failures} allowlisted=${allowlisted}"

  if [[ "${failures}" -ne 0 ]]; then
    return 1
  fi
  return 0
}

scan_python_supply_chain() {
  local allowlist_path="$1"

  local -a files=()
  while IFS= read -r f; do
    files+=("$f")
  done < <(
    find "${REPO_ROOT}" -maxdepth 6 -type f \( \
      -name 'requirements*.txt' -o \
      -name 'constraints*.txt' -o \
      -name 'Pipfile' -o \
      -name 'Pipfile.lock' -o \
      -name 'poetry.lock' -o \
      -name 'pdm.lock' -o \
      -name 'uv.lock' -o \
      -name 'pyproject.toml' \
    \) \
    -not -path '*/node_modules/*' \
    -not -path '*/.git/*' \
    -not -path '*/.venv/*' \
    -not -path '*/venv/*' \
    -not -path '*/__pycache__/*' \
    2>/dev/null | LC_ALL=C sort
  )

  if [[ "${#files[@]}" -eq 0 ]]; then
    echo "Python supply-chain scan: no Python dependency files detected; skipping."
    return 0
  fi

  local known_malicious=(
    "python3-dateutil"
    "jeilyfish"
    "python-binance"
    "request"
    "urllib"
    "djanga"
    "coloursama"
    "larpexodus"
    "graphalgo"
    "acloud-client"
    "tcloud-python-test"
  )

  local failures=0
  local allowlisted=0
  local file_count=0

  local f
  for f in "${files[@]}"; do
    file_count=$((file_count + 1))
    local rel="${f#${REPO_ROOT}/}"

    local line
    while IFS= read -r line || [[ -n "${line}" ]]; do
      local raw="${line//$'\r'/}"
      local trimmed
      trimmed="$(printf '%s' "${raw}" | sed -E 's/[[:space:]]+/ /g; s/^ +//; s/ +$//')"
      [[ -z "${trimmed}" ]] && continue

      local lower
      lower="$(printf '%s' "${trimmed}" | tr '[:upper:]' '[:lower:]')"

      local rule=""

      local pkg
      for pkg in "${known_malicious[@]}"; do
        if [[ "${lower}" == *"${pkg}"* ]]; then
          rule="KNOWN_MALICIOUS_PACKAGE"
          break
        fi
      done

      if [[ -z "${rule}" ]]; then
        if [[ "${lower}" == *"git+https://"* || "${lower}" == *"git+http://"* || "${lower}" == *"git+ssh://"* || "${lower}" == *"hg+http"* || "${lower}" == *"svn+http"* || "${lower}" == *"bzr+http"* ]]; then
          rule="VCS_OR_URL_DEP"
        elif [[ "${lower}" == *" @ https://"* || "${lower}" == *" @ http://"* || "${lower}" == *" @ file://"* || "${lower}" == *" @ ssh://"* ]]; then
          rule="VCS_OR_URL_DEP"
        elif [[ "${lower}" == *"git = \""* && ( "${lower}" == *"http://"* || "${lower}" == *"https://"* || "${lower}" == *"ssh://"* ) ]]; then
          rule="VCS_OR_URL_DEP"
        fi
      fi

      if [[ -z "${rule}" ]]; then
        if [[ "${lower}" == *"--index-url"* || "${lower}" == *"--extra-index-url"* || "${lower}" == *"--find-links"* ]] || [[ "${lower}" =~ (^|[[:space:]])-f([[:space:]]|$) ]]; then
          rule="CUSTOM_INDEX"
        elif [[ "${lower}" == *"--trusted-host"* ]]; then
          rule="TRUSTED_HOST"
        elif [[ "${lower}" == "-e "* || "${lower}" == "--editable "* ]]; then
          rule="EDITABLE_INSTALL"
        fi
      fi

      [[ -z "${rule}" ]] && continue

      local h
      h="$(sha256_12 "${rel}|${rule}|${trimmed}")" || return $?
      local id="GOV-SUPPLY:PYTHON:LINE:file=${rel}:rule=${rule}:sha256=${h}"

      if allowlist_has_id "${allowlist_path}" "${id}"; then
        allowlisted=$((allowlisted + 1))
      else
        failures=$((failures + 1))
        echo "- ${id} detail=${trimmed:0:200}"
      fi
    done < "${f}"
  done

  echo "Supply-chain scan (Python): files=${file_count} findings=${failures} allowlisted=${allowlisted}"

  if [[ "${failures}" -ne 0 ]]; then
    return 1
  fi
  return 0
}

check_supply_chain_apptheory() {
  local allowlist="${PLANNING_DIR}/apptheory-supply-chain-allowlist.txt"
  if [[ -f "${allowlist}" ]]; then
    echo "Supply-chain allowlist: ${allowlist}"
  else
    echo "Supply-chain allowlist: missing (treated as empty): ${allowlist}"
  fi

  local fail=0
  local blocked=0

  set +e
  check_supply_chain_actions_pinned
  local ec_actions=$?
  set -e
  if [[ $ec_actions -ne 0 ]]; then
    fail=1
  fi

  # Node projects to scan (explicit to prevent "green by removing a directory").
  local -a node_projects=(
    "ts"
    "cdk"
    "examples/cdk/multilang"
    "examples/cdk/ssr-site"
  )

  local proj
  for proj in "${node_projects[@]}"; do
    if [[ ! -d "${proj}" ]]; then
      echo "FAIL: expected Node project directory missing: ${proj}" >&2
      fail=1
      continue
    fi

    echo ""
    echo "=== Node supply-chain project: ${proj} ==="

    local tmp_dir
    tmp_dir="$(mktemp -d)"
    # Use a local cleanup to avoid leaving node_modules around.
    local cleanup_proj
    cleanup_proj() { rm -rf "${tmp_dir}"; }

    cp -a "${proj}" "${tmp_dir}/proj"

    set +e
    install_node_deps_ignore_scripts_in_dir "${tmp_dir}/proj"
    local ec_install=$?
    set -e

    if [[ $ec_install -eq 2 ]]; then
      blocked=1
      cleanup_proj
      continue
    elif [[ $ec_install -ne 0 ]]; then
      fail=1
      cleanup_proj
      continue
    fi

    set +e
    scan_node_modules_supply_chain_in_dir "${tmp_dir}/proj" "${allowlist}"
    local ec_scan=$?
    set -e

    if [[ $ec_scan -eq 2 ]]; then
      blocked=1
    elif [[ $ec_scan -ne 0 ]]; then
      fail=1
    fi

    cleanup_proj
  done

  set +e
  ensure_cdk_dist_go_bindings_generated
  local ec_cdk_go=$?
  set -e
  if [[ $ec_cdk_go -eq 2 ]]; then
    blocked=1
  elif [[ $ec_cdk_go -ne 0 ]]; then
    fail=1
  fi

  # Go supply-chain scanning across in-scope go.mod files.
  local -a go_mods=(
    "${REPO_ROOT}/go.mod"
    "${REPO_ROOT}/cdk/dist/go/apptheorycdk/go.mod"
  )

  local gm
  for gm in "${go_mods[@]}"; do
    set +e
    scan_go_supply_chain_for_mod "${gm}" "${allowlist}"
    local ec_go=$?
    set -e
    if [[ $ec_go -eq 2 ]]; then
      blocked=1
    elif [[ $ec_go -ne 0 ]]; then
      fail=1
    fi
  done

  set +e
  scan_python_supply_chain "${allowlist}"
  local ec_py=$?
  set -e
  if [[ $ec_py -eq 2 ]]; then
    blocked=1
  elif [[ $ec_py -ne 0 ]]; then
    fail=1
  fi

  if [[ "${fail}" -ne 0 ]]; then
    return 1
  fi
  if [[ "${blocked}" -ne 0 ]]; then
    return 2
  fi
  return 0
}

# Helper: run a single check and record result
run_check() {
  local id="$1"
  local category="$2"
  local cmd="$3"

  local output_file="${EVIDENCE_DIR}/${id}-output.log"

  if [[ -z "${cmd//[[:space:]]/}" ]] || [[ "${cmd}" == "UNSET:"* ]] || [[ "${cmd}" == "BLOCKED:"* ]] || [[ "${cmd}" == "{{CMD_"* ]]; then
    printf '%s\n' "Verifier command not configured: ${cmd}" > "${output_file}"
    record_result "$id" "$category" "BLOCKED" "Verifier command not configured" "$output_file"
    return 0
  fi

  set +e
  (
    set -euo pipefail
    eval "${cmd}"
  ) >"${output_file}" 2>&1
  local ec=$?
  set -e

  if [[ $ec -eq 0 ]]; then
    record_result "$id" "$category" "PASS" "Command succeeded" "$output_file"
  elif [[ $ec -eq 2 || $ec -eq 126 || $ec -eq 127 ]]; then
    record_result "$id" "$category" "BLOCKED" "Command reported BLOCKED (exit code ${ec})" "$output_file"
  else
    record_result "$id" "$category" "FAIL" "Command failed with exit code ${ec}" "$output_file"
  fi
}

check_file_exists() {
  local id="$1"
  local category="$2"
  local file_path="$3"

  if [[ -f "${file_path}" ]]; then
    record_result "$id" "$category" "PASS" "File exists" "$file_path"
  else
    record_result "$id" "$category" "FAIL" "Required file missing" "$file_path"
  fi
}

check_parity() {
  local threat_model="${PLANNING_DIR}/apptheory-threat-model.md"
  local controls_matrix="${PLANNING_DIR}/apptheory-controls-matrix.md"
  local evidence_path="${EVIDENCE_DIR}/DOC-5-parity.log"

  if [[ ! -f "${threat_model}" ]] || [[ ! -f "${controls_matrix}" ]]; then
    printf '%s\n' "Threat model or controls matrix missing" > "${evidence_path}"
    record_result "DOC-5" "Docs" "BLOCKED" "Threat model or controls matrix missing" "${evidence_path}"
    return 0
  fi

  local threat_ids
  threat_ids="$(grep -oE 'THR-[0-9]+' "${threat_model}" | sort -u || true)"

  local missing=""
  local thr_id
  for thr_id in ${threat_ids}; do
    if ! grep -q "${thr_id}" "${controls_matrix}"; then
      missing="${missing} ${thr_id}"
    fi
  done

  {
    echo "Threat IDs found: ${threat_ids:-none}"
    echo "Missing from controls:${missing:-none}"
  } > "${evidence_path}"

  if [[ -z "${missing}" ]]; then
    record_result "DOC-5" "Docs" "PASS" "All threat IDs mapped in controls matrix" "${evidence_path}"
  else
    record_result "DOC-5" "Docs" "FAIL" "Unmapped threats:${missing}" "${evidence_path}"
  fi
}

echo "=== GovTheory Rubric Verifier ==="
echo "Project: AppTheory"
echo "Timestamp: ${REPORT_TIMESTAMP}"
echo ""

normalize_feature_flags

# Commands are centralized here so docs and verifier stay aligned.
CMD_UNIT="gov_cmd_unit"
CMD_INTEGRATION="gov_cmd_integration"
CMD_COVERAGE="check_coverage"

CMD_FMT="gov_cmd_fmt"
CMD_LINT="gov_cmd_lint"
CMD_CONTRACT="gov_cmd_contract"

CMD_MODULES="check_multi_module_health"
CMD_TOOLCHAIN="check_toolchain_pins"
CMD_LINT_CONFIG="check_lint_config_valid"
CMD_COV_THRESHOLD="check_coverage_threshold_floor"
CMD_SEC_CONFIG="check_security_config"
CMD_LOGGING="check_logging_ops_standards"

CMD_SAST="gov_cmd_sast"
CMD_VULN="gov_cmd_vuln"
CMD_SUPPLY="check_supply_chain_apptheory"
CMD_P0="gov_cmd_p0"

CMD_FILE_BUDGET="check_file_budgets"
CMD_MAINTAINABILITY="check_maintainability_roadmap"
CMD_SINGLETON="check_duplicate_semantics"

CMD_DOC_INTEGRITY="check_doc_integrity"
CMD_DOCS_STANDARD="check_docs_standard"

# === Quality (QUA) ===
run_check "QUA-1" "Quality" "$CMD_UNIT"
run_check "QUA-2" "Quality" "$CMD_INTEGRATION"
run_check "QUA-3" "Quality" "$CMD_COVERAGE"

# === Consistency (CON) ===
run_check "CON-1" "Consistency" "$CMD_FMT"
run_check "CON-2" "Consistency" "$CMD_LINT"
run_check "CON-3" "Consistency" "$CMD_CONTRACT"

# === Completeness (COM) ===
run_check "COM-1" "Completeness" "$CMD_MODULES"
run_check "COM-2" "Completeness" "$CMD_TOOLCHAIN"
run_check "COM-3" "Completeness" "$CMD_LINT_CONFIG"
run_check "COM-4" "Completeness" "$CMD_COV_THRESHOLD"
run_check "COM-5" "Completeness" "$CMD_SEC_CONFIG"
run_check "COM-6" "Completeness" "$CMD_LOGGING"

# === Security (SEC) ===
run_check "SEC-1" "Security" "$CMD_SAST"
run_check "SEC-2" "Security" "$CMD_VULN"
run_check "SEC-3" "Security" "$CMD_SUPPLY"
run_check "SEC-4" "Security" "$CMD_P0"

# === Compliance Readiness (CMP) ===
check_file_exists "CMP-1" "Compliance" "${PLANNING_DIR}/apptheory-controls-matrix.md"
check_file_exists "CMP-2" "Compliance" "${PLANNING_DIR}/apptheory-evidence-plan.md"
check_file_exists "CMP-3" "Compliance" "${PLANNING_DIR}/apptheory-threat-model.md"

# === Maintainability (MAI) ===
run_check "MAI-1" "Maintainability" "$CMD_FILE_BUDGET"
run_check "MAI-2" "Maintainability" "$CMD_MAINTAINABILITY"
run_check "MAI-3" "Maintainability" "$CMD_SINGLETON"

# === Docs (DOC) ===
check_file_exists "DOC-1" "Docs" "${PLANNING_DIR}/apptheory-threat-model.md"
check_file_exists "DOC-2" "Docs" "${PLANNING_DIR}/apptheory-evidence-plan.md"
check_file_exists "DOC-3" "Docs" "${PLANNING_DIR}/apptheory-10of10-rubric.md"
run_check "DOC-4" "Docs" "$CMD_DOC_INTEGRITY"
run_check "DOC-6" "Docs" "$CMD_DOCS_STANDARD"
check_parity

# === Release (REL) — optional ===
if [[ "${FEATURE_OSS_RELEASE}" == "true" ]]; then
  # Feature not enabled for this init; fail closed by not running optional gates.
  :
fi

# === Generate Report ===
echo ""
echo "=== Generating Report ==="

RESULTS_JSON=$(printf "%s," "${RESULTS[@]}")
RESULTS_JSON="[${RESULTS_JSON%,}]"

OVERALL_STATUS="PASS"
if [[ ${FAIL_COUNT} -gt 0 ]]; then
  OVERALL_STATUS="FAIL"
elif [[ ${BLOCKED_COUNT} -gt 0 ]]; then
  OVERALL_STATUS="BLOCKED"
fi

cat > "${REPORT_PATH}" <<EOF
{
  "\$schema": "https://gov.pai.dev/schemas/gov-rubric-report.schema.json",
  "schemaVersion": ${REPORT_SCHEMA_VERSION},
  "timestamp": "${REPORT_TIMESTAMP}",
  "pack": {
    "version": "2ba585f48951",
    "digest": "22406dbb1031ebc4dcd83e02912bbc307ab0983629463aa6106b76415e6280af"
  },
  "project": {
    "name": "AppTheory",
    "slug": "apptheory"
  },
  "summary": {
    "status": "${OVERALL_STATUS}",
    "pass": ${PASS_COUNT},
    "fail": ${FAIL_COUNT},
    "blocked": ${BLOCKED_COUNT}
  },
  "results": ${RESULTS_JSON}
}
EOF

echo "Report written to: ${REPORT_PATH}"
echo ""
echo "=== Summary ==="
echo "Status: ${OVERALL_STATUS}"
echo "Pass: ${PASS_COUNT}"
echo "Fail: ${FAIL_COUNT}"
echo "Blocked: ${BLOCKED_COUNT}"

if [[ "${OVERALL_STATUS}" == "PASS" ]]; then
  exit 0
else
  exit 1
fi
