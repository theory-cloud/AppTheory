#!/usr/bin/env bash
# Purpose: prove scripts/verify-npm-install-hygiene.sh (cmd/ci-guard) fails
# closed on every R-G3 bypass reproduced in review round 0, and still passes on
# the shipped tree.
#
# Reproduced bypasses (all previously PASSED while npm ran lifecycle scripts):
#   - `npm ci # --ignore-scripts`                (flag only in a comment)
#   - `(cd ts && npm ci) # --ignore-scripts`     (flag only in a comment, subshell)
#   - `bash -c '... npm ci ...' # <flag>`        (flag only in a comment, nested shell)
#   - `npm ci --ignore-scripts=false`            (scripts explicitly re-enabled)
# plus the canonical regressions (bare `npm ci`, `npm install`, `yarn install`,
# an `npx`-prefixed install, a second unprotected install after `&&`, a Makefile
# recipe and a workflow `run:` step).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

if ! command -v go >/dev/null 2>&1; then
  echo "test-verify-npm-install-hygiene: BLOCKED (go toolchain not found)" >&2
  exit 2
fi

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT
root="${workdir}/repo"
mkdir -p "${root}/scripts" "${root}/.github/workflows"
out="${workdir}/out"

surfaces=(
  "Makefile"
  ".github/workflows/probe.yml"
  "scripts/verify-scaffold-examples.sh"
  "scripts/probe.sh"
)

write_scaffold_exceptions() {
  cat >"${root}/scripts/verify-scaffold-examples.sh" <<'FIXTURE'
#!/usr/bin/env bash
  npm install --ignore-scripts >/dev/null
  npm install --ignore-scripts >/dev/null
  npm install --ignore-scripts >/dev/null
FIXTURE
}

write_probe_sh() {
  cat >"${root}/scripts/probe.sh"
}

write_probe_yml() {
  cat >"${root}/.github/workflows/probe.yml" <<YAML
name: probe
on: push
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - run: $1
YAML
}

reset_fixture() {
  write_scaffold_exceptions
  printf 'all:\n\t@true\n' >"${root}/Makefile"
  write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
(cd ts && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)
FIXTURE
  write_probe_yml "echo ok"
}

run_guard() {
  set +e
  printf '%s\n' "${surfaces[@]}" |
    go run ./cmd/ci-guard install-hygiene --root "${root}" >"${out}" 2>&1
  local status=$?
  set -e
  printf '%s' "${status}"
}

expect_fail() {
  local label="$1"
  local needle="$2"
  local status
  status="$(run_guard)"
  if [[ "${status}" == "0" ]]; then
    cat "${out}" >&2
    echo "test-verify-npm-install-hygiene: FAIL (${label}: guard must FAIL)" >&2
    exit 1
  fi
  if ! grep -Fq -- "${needle}" "${out}"; then
    cat "${out}" >&2
    echo "test-verify-npm-install-hygiene: FAIL (${label}: guard output does not mention ${needle})" >&2
    exit 1
  fi
}

expect_pass() {
  local label="$1"
  local status
  status="$(run_guard)"
  if [[ "${status}" != "0" ]]; then
    cat "${out}" >&2
    echo "test-verify-npm-install-hygiene: FAIL (${label}: guard must PASS, got ${status})" >&2
    exit 1
  fi
}

# Green baseline.
reset_fixture
expect_pass "hardened baseline"

# A. The flag cannot be hidden behind a comment, in any position.
reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
npm ci # --ignore-scripts
FIXTURE
expect_fail "flag hidden in a trailing comment" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
(cd ts && npm ci) # --ignore-scripts
FIXTURE
expect_fail "subshell install with a comment-masked flag" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
bash -c 'cd ts && npm ci --no-audit --no-fund >/dev/null' # --ignore-scripts
FIXTURE
expect_fail "bash -c payload with a comment-masked flag" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
x="$(cd ts && npm ci)" # --ignore-scripts
FIXTURE
expect_fail "command substitution with a comment-masked flag" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
bash <<'EOF'
npm ci
EOF
FIXTURE
expect_fail "install inside a nested shell heredoc" "install without --ignore-scripts"

# B. The flag cannot be turned back off.
reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
npm ci --ignore-scripts=false
FIXTURE
expect_fail "scripts explicitly re-enabled" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
npm ci --ignore-scripts=0
FIXTURE
expect_fail "scripts re-enabled with a non-true value" "install without --ignore-scripts"

# C. Canonical regressions.
reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
npm ci
FIXTURE
expect_fail "bare npm ci" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
npm install
FIXTURE
expect_fail "bare npm install" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
(cd app && yarn install)
FIXTURE
expect_fail "bare yarn install" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
npx npm ci
FIXTURE
expect_fail "npx-prefixed install" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
npm ci --ignore-scripts && npm ci
FIXTURE
expect_fail "second unprotected install after &&" "install without --ignore-scripts"

reset_fixture
printf 'all:\n\t@(cd ts && npm ci)\n' >"${root}/Makefile"
expect_fail "Makefile recipe install" "install without --ignore-scripts"

reset_fixture
write_probe_yml "cd ts && npm ci"
expect_fail "workflow run step install" "install without --ignore-scripts"

reset_fixture
printf 'all:\n\t@true\nPACK := $(shell npm ci)\n' >"${root}/Makefile"
expect_fail "Makefile shell function install" "install without --ignore-scripts"

reset_fixture
write_probe_yml "npm ci --ignore-scripts"
python3 - "${root}/.github/workflows/probe.yml" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8").replace("      - run: npm ci --ignore-scripts\n", "      - run:\n          - npm ci\n")
path.write_text(text, encoding="utf-8")
PY
expect_fail "workflow run step with a non-string value" "must be a plain string"

# D. Green cases: the hardened forms the tree actually uses.
reset_fixture
expect_pass "hardened shell baseline"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
(cd ts && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)
bash -c 'cd cdk && npm ci --ignore-scripts --no-audit --no-fund >/dev/null'
npm_config_loglevel=warn npm install --ignore-scripts --prefix "${p}" release-please@17.1.3
stamp="$(npm ci --ignore-scripts >/dev/null)"
echo "cdk-synth: FAIL (CDK dependencies incomplete; run 'cd cdk && npm ci')"
FIXTURE
expect_pass "hardened installs and message text"

reset_fixture
write_probe_yml "cd ts && npm ci --ignore-scripts --no-audit --no-fund"
expect_pass "hardened workflow run step"

reset_fixture
printf 'all:\n\t@(cd ts && npm ci --ignore-scripts)\n' >"${root}/Makefile"
expect_pass "hardened Makefile recipe"

# E. The wrapper runs the real tree.
reset_fixture
if ! bash "${repo_root}/scripts/verify-npm-install-hygiene.sh" >"${out}" 2>&1; then
  cat "${out}" >&2
  echo "test-verify-npm-install-hygiene: FAIL (the guard must PASS on the real tree)" >&2
  exit 1
fi

echo "test-verify-npm-install-hygiene: PASS"
