#!/usr/bin/env bash
# Purpose: fail closed when a package install in an executable surface does not
# use the lockfile with lifecycle scripts disabled (R-G3): every install must
# carry `--ignore-scripts` (or the yarn/pnpm equivalent), so a compromised
# dependency's install hooks never run inside CI, the rubric, or gov-infra.
#
# Surface: the executable surfaces that can install packages in this repository
# are .github/workflows/**, scripts/**, gov-infra/** (verifier code, not the
# planning documents) and the Makefile. Documentation, templates and examples
# only describe installs; they are not install commands.
#
# The check is delegated to cmd/ci-guard, which parses workflow YAML as YAML and
# tokenizes shell command positions (stripping unquoted comments, splitting on
# `&&`/`||`/`;`/pipes/subshells and following `bash -c` payloads). Matching on
# the raw line was bypassable: `npm ci # --ignore-scripts`,
# `(cd ts && npm ci) # --ignore-scripts`, `bash -c '... npm ci ...' # <flag>` and
# `npm ci --ignore-scripts=false` all ran lifecycle scripts while passing.
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

printf '%s\n' "${surfaces}" | go run ./cmd/ci-guard install-hygiene --root "$(pwd)"
