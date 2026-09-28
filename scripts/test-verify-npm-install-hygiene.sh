#!/usr/bin/env bash
# Purpose: prove scripts/verify-npm-install-hygiene.sh (cmd/ci-guard) fails
# closed on every R-G3 bypass reproduced in review rounds 0 and 1, and still
# passes on the shipped tree.
#
# Round 0 reproduced bypasses (all previously PASSED while npm ran lifecycle
# scripts):
#   - `npm ci # --ignore-scripts`                (flag only in a comment)
#   - `(cd ts && npm ci) # --ignore-scripts`     (flag only in a comment, subshell)
#   - `bash -c '... npm ci ...' # <flag>`        (flag only in a comment, nested shell)
#   - `npm ci --ignore-scripts=false`            (scripts explicitly re-enabled)
#
# Round 1 reproduced bypasses (SAN-AT1073-R1-F1 / ADV-1073-R1-02 — every one
# returned exit 0 with zero violations while a scripts-enabled install ran):
#   - launcher flags and pinned specs: `npx -y npm ci`, `npx --yes npm@10.9.0 ci`,
#     `npx npm@10.9.0 ci`, `pnpm dlx npm ci`, `corepack npm ci`, `xargs npm ci`
#   - flags before a nested shell's `-c`: `bash -eu -c 'npm ci'`
#   - variable indirection: `NPM=npm; $NPM ci`, `CMD='npm ci'; $CMD`,
#     `env NPM=npm $NPM ci`
#   - `eval npm ci`
#   - shell keywords: `if npm ci`, `while npm ci`, `! npm ci`
#   - a heredoc piped into a shell: `cat <<'EOF' | bash`
#   - a lockfile directory with no scripts-disabled config at all
#
# plus the canonical regressions (bare `npm ci`, `npm install`, `yarn install`,
# an `npx`-prefixed install, a second unprotected install after `&&`, a Makefile
# recipe and a workflow `run:` step) and the green cases the tree actually uses.
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
mkdir -p "${root}/scripts" "${root}/.github/workflows" "${root}/ts"
out="${workdir}/out"

surfaces=(
  "Makefile"
  ".github/workflows/probe.yml"
  "scripts/verify-scaffold-examples.sh"
  "scripts/probe.sh"
)
lockfiles="ts/package-lock.json"

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
  rm -rf "${root}/app"
  : >"${root}/ts/package-lock.json"
  printf 'ignore-scripts=true\n' >"${root}/ts/.npmrc"
  lockfiles="ts/package-lock.json"
}

run_surface_guard() {
  set +e
  printf '%s\n' "${surfaces[@]}" |
    go run ./cmd/ci-guard install-hygiene --root "${root}" >"${out}" 2>&1
  local status=$?
  set -e
  printf '%s' "${status}"
}

run_lockfile_guard() {
  set +e
  printf '%s\n' "${lockfiles}" |
    go run ./cmd/ci-guard lockfile-config --root "${root}" >"${out}" 2>&1
  local status=$?
  set -e
  printf '%s' "${status}"
}

fail_with_output() {
  local label="$1"
  local message="$2"
  cat "${out}" >&2
  echo "test-verify-npm-install-hygiene: FAIL (${label}: ${message})" >&2
  exit 1
}

expect_guard_fail() {
  local label="$1"
  local needle="$2"
  local status="$3"
  if [[ "${status}" == "0" ]]; then
    fail_with_output "${label}" "guard must FAIL"
  fi
  if ! grep -Fq -- "${needle}" "${out}"; then
    fail_with_output "${label}" "guard output does not mention ${needle}"
  fi
}

expect_guard_pass() {
  local label="$1"
  local status="$2"
  if [[ "${status}" != "0" ]]; then
    fail_with_output "${label}" "guard must PASS, got ${status}"
  fi
}

expect_surface_fail() { expect_guard_fail "$1" "$2" "$(run_surface_guard)"; }
expect_surface_pass() { expect_guard_pass "$1" "$(run_surface_guard)"; }
expect_lockfile_fail() { expect_guard_fail "$1" "$2" "$(run_lockfile_guard)"; }
expect_lockfile_pass() { expect_guard_pass "$1" "$(run_lockfile_guard)"; }

# Green baseline: the hardened fixture, both checks.
reset_fixture
expect_surface_pass "hardened shell baseline"
expect_lockfile_pass "hardened lockfile baseline"

# A. The flag cannot be hidden behind a comment, in any position.
reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
npm ci # --ignore-scripts
FIXTURE
expect_surface_fail "flag hidden in a trailing comment" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
(cd ts && npm ci) # --ignore-scripts
FIXTURE
expect_surface_fail "subshell install with a comment-masked flag" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
bash -c 'cd ts && npm ci --no-audit --no-fund >/dev/null' # --ignore-scripts
FIXTURE
expect_surface_fail "bash -c payload with a comment-masked flag" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
x="$(cd ts && npm ci)" # --ignore-scripts
FIXTURE
expect_surface_fail "command substitution with a comment-masked flag" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
bash <<'EOF'
npm ci
EOF
FIXTURE
expect_surface_fail "install inside a nested shell heredoc" "install without --ignore-scripts"

# B. The flag cannot be turned back off.
reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
npm ci --ignore-scripts=false
FIXTURE
expect_surface_fail "scripts explicitly re-enabled" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
npm ci --ignore-scripts=0
FIXTURE
expect_surface_fail "scripts re-enabled with a non-true value" "install without --ignore-scripts"

# C. Canonical regressions.
reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
npm ci
FIXTURE
expect_surface_fail "bare npm ci" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
npm install
FIXTURE
expect_surface_fail "bare npm install" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
(cd app && yarn install)
FIXTURE
expect_surface_fail "bare yarn install" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
npx npm ci
FIXTURE
expect_surface_fail "npx-prefixed install" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
npm ci --ignore-scripts && npm ci
FIXTURE
expect_surface_fail "second unprotected install after &&" "install without --ignore-scripts"

reset_fixture
printf 'all:\n\t@(cd ts && npm ci)\n' >"${root}/Makefile"
expect_surface_fail "Makefile recipe install" "install without --ignore-scripts"

reset_fixture
write_probe_yml "cd ts && npm ci"
expect_surface_fail "workflow run step install" "install without --ignore-scripts"

reset_fixture
printf 'all:\n\t@true\nPACK := $(shell npm ci)\n' >"${root}/Makefile"
expect_surface_fail "Makefile shell function install" "install without --ignore-scripts"

reset_fixture
write_probe_yml "npm ci --ignore-scripts"
python3 - "${root}/.github/workflows/probe.yml" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8").replace("      - run: npm ci --ignore-scripts\n", "      - run:\n          - npm ci\n")
path.write_text(text, encoding="utf-8")
PY
expect_surface_fail "workflow run step with a non-string value" "must be a plain string"

# D. Launcher spellings reproduced in round 1 (SAN-AT1073-R1-F1).
launcher_cases=(
  "npx -y npm ci"
  "npx --yes npm@10.9.0 ci"
  "npx npm@10.9.0 ci"
  "pnpm dlx npm ci"
  "pnpm dlx -y npm ci"
  "corepack npm ci"
  "corepack pnpm install"
  "corepack npm@10 ci"
  "bash -eu -c 'npm ci'"
  "sh -e -c 'cd ts && npm ci'"
  "NPM=npm; \$NPM ci"
  "CMD='npm ci'; \$CMD"
  "env NPM=npm \$NPM ci"
  "xargs npm ci"
  "xargs -0 npm ci"
  "sudo -u root npm ci"
  "nice -n 10 npm ci"
  "env -u FOO npm ci"
  "eval npm ci"
  "if npm ci; then :; fi"
  "while npm ci; do :; done"
  "! npm ci"
)
for probe in "${launcher_cases[@]}"; do
  reset_fixture
  write_probe_sh <<FIXTURE
#!/usr/bin/env bash
${probe}
FIXTURE
  expect_surface_fail "launcher spelling: ${probe}" "install without --ignore-scripts"
done

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
cat <<'EOF' | bash
npm ci
EOF
FIXTURE
expect_surface_fail "heredoc piped into a shell" "install without --ignore-scripts"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
cat <<EOF | sh
npm install
EOF
FIXTURE
expect_surface_fail "heredoc piped into sh" "install without --ignore-scripts"

# E. Lockfile config hardening: a lockfile directory without the config, or
# with scripts turned back on, fails closed.
reset_fixture
rm -f "${root}/ts/.npmrc"
expect_lockfile_fail "lockfile directory without .npmrc" "missing"

reset_fixture
printf 'ignore-scripts=true\nignore-scripts=false\n' >"${root}/ts/.npmrc"
expect_lockfile_fail "lockfile directory turning scripts back on" "must stay disabled"

reset_fixture
rm -f "${root}/ts/.npmrc"
printf 'ignore-scripts=true\n' >"${root}/ts/.npmrc.bak"
expect_lockfile_fail "config present but not next to the lockfile" "missing"

reset_fixture
lockfiles="ts/package-lock.json
app/pnpm-lock.yaml"
mkdir -p "${root}/app"
: >"${root}/app/pnpm-lock.yaml"
printf 'ignore-scripts=true\n' >"${root}/app/.npmrc"
expect_lockfile_pass "pnpm lockfile with ignore-scripts"

reset_fixture
lockfiles="ts/package-lock.json
app/pnpm-lock.yaml"
mkdir -p "${root}/app"
: >"${root}/app/pnpm-lock.yaml"
expect_lockfile_fail "pnpm lockfile without config" "missing"

reset_fixture
lockfiles="ts/package-lock.json
app/yarn.lock"
mkdir -p "${root}/app"
: >"${root}/app/yarn.lock"
printf 'enableScripts: false\n' >"${root}/app/.yarnrc.yml"
expect_lockfile_pass "yarn berry with enableScripts false"

reset_fixture
lockfiles="ts/package-lock.json
app/yarn.lock"
mkdir -p "${root}/app"
: >"${root}/app/yarn.lock"
printf 'enableScripts: true\n' >"${root}/app/.yarnrc.yml"
expect_lockfile_fail "yarn berry with enableScripts true" "enableScripts"

reset_fixture
lockfiles="ts/package-lock.json
app/yarn.lock"
mkdir -p "${root}/app"
: >"${root}/app/yarn.lock"
printf 'ignore-scripts=true\n' >"${root}/app/.npmrc"
expect_lockfile_pass "yarn classic via .npmrc"

# F. Green cases: launchers that run something other than a package manager, an
# unresolvable variable command, and the hardened forms the tree actually uses.
reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
(cd ts && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)
bash -c 'cd cdk && npm ci --ignore-scripts --no-audit --no-fund >/dev/null'
npm_config_loglevel=warn npm install --ignore-scripts --prefix "${p}" release-please@17.1.3
stamp="$(npm ci --ignore-scripts >/dev/null)"
echo "cdk-synth: FAIL (CDK dependencies incomplete; run 'cd cdk && npm ci')"
FIXTURE
expect_surface_pass "hardened installs and message text"

reset_fixture
write_probe_sh <<'FIXTURE'
#!/usr/bin/env bash
cd cdk && npx jsii-pacmak -t go --code-only -o dist/go --force
npx cdk synth --quiet --no-notices
npx --yes jsii-pacmak -t python
corepack enable
xargs grep -n needle
eval "${cmd}"
cat <<'DOC' | tee out.txt
- `npm i ./apptheory.tgz`
DOC
FIXTURE
expect_surface_pass "launchers that run another tool and data heredocs"

reset_fixture
write_probe_yml "cd ts && npm ci --ignore-scripts --no-audit --no-fund"
expect_surface_pass "hardened workflow run step"

reset_fixture
printf 'all:\n\t@(cd ts && npm ci --ignore-scripts)\n' >"${root}/Makefile"
expect_surface_pass "hardened Makefile recipe"

# G. The wrapper runs both checks against the real tree.
reset_fixture
if ! bash "${repo_root}/scripts/verify-npm-install-hygiene.sh" >"${out}" 2>&1; then
  cat "${out}" >&2
  echo "test-verify-npm-install-hygiene: FAIL (the guard must PASS on the real tree)" >&2
  exit 1
fi

echo "test-verify-npm-install-hygiene: PASS"
