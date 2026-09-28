#!/usr/bin/env bash
# Purpose: fail closed when a package install in an executable surface does not
# use the lockfile with lifecycle scripts disabled (R-G3): every lockfile
# directory must carry the config that disables install scripts structurally
# (.npmrc `ignore-scripts=true`; Yarn Berry `.yarnrc.yml` `enableScripts:
# false`), and every install must carry `--ignore-scripts` (or the yarn/pnpm
# equivalent), so a compromised dependency's install hooks never run inside CI,
# the rubric, or gov-infra. The config makes scripts impossible; the tokenizer
# is the second line of defense.
#
# Surface: the executable surfaces that can install packages in this repository
# are .github/workflows/**, scripts/**, gov-infra/** (verifier code, not the
# planning documents) and the Makefile. Documentation, templates and examples
# only describe installs; they are not install commands.
#
# The check is delegated to cmd/ci-guard, which parses workflow YAML as YAML and
# tokenizes shell command positions (stripping unquoted comments, splitting on
# `&&`/`||`/`;`/pipes/subshells, following `bash -c` payloads and heredocs, and
# unwrapping launchers such as `npx`/`corepack`/`xargs`/`eval` and
# `$VAR`-indirected commands). Matching on the raw line was bypassable:
# `npm ci # --ignore-scripts`, `(cd ts && npm ci) # --ignore-scripts`,
# `bash -c '... npm ci ...' # <flag>` and `npm ci --ignore-scripts=false` all
# ran lifecycle scripts while passing.
#
# Non-`ci` installs are only accepted when they install an immutable spec
# (an exact registry version, a packed tarball, or a file: path) or when they are
# one of the recorded, count-asserted exceptions below.
#
# Exit codes: 0 PASS, 1 FAIL (a violating install was found), 2 BLOCKED.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

git="$(command -v git || true)"
if [[ -z "${git}" ]]; then
  echo "npm-install-hygiene: BLOCKED (git not found)" >&2
  exit 2
fi
if ! command -v go >/dev/null 2>&1; then
  echo "npm-install-hygiene: BLOCKED (go toolchain not found; cmd/ci-guard parses the surfaces)" >&2
  exit 2
fi

surfaces="$(
  "${git}" ls-files -- '.github/workflows' 'scripts' 'gov-infra' 'Makefile' \
    | { grep -Ev '^gov-infra/planning/' || true; } \
    | { grep -E '\.(sh|ya?ml)$|^Makefile$' || true; } \
    | LC_ALL=C sort
)"

if [[ -z "${surfaces}" ]]; then
  echo "npm-install-hygiene: BLOCKED (no executable surfaces found to scan)" >&2
  exit 2
fi

# Lifecycle scripts are structurally impossible, not merely detected: every
# lockfile directory the repository installs from must carry the package-manager
# config that disables install scripts (.npmrc `ignore-scripts=true`, or Yarn
# Berry's `.yarnrc.yml` `enableScripts: false`). A single install invocation
# that forgets `--ignore-scripts` then cannot run a dependency's install hooks,
# and the guard fails closed if the config is missing or turns scripts back on.
lockfiles="$(
  "${git}" ls-files --cached --others --exclude-standard \
    | { grep -E '(^|/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$' || true; } \
    | LC_ALL=C sort
)"

if [[ -z "${lockfiles}" ]]; then
  echo "npm-install-hygiene: BLOCKED (no lockfiles found to check for scripts-disabled config)" >&2
  exit 2
fi

printf '%s\n' "${lockfiles}" | go run ./cmd/ci-guard lockfile-config --root "$(pwd)"

printf '%s\n' "${surfaces}" | go run ./cmd/ci-guard install-hygiene --root "$(pwd)"
