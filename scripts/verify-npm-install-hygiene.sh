#!/usr/bin/env bash
# Purpose: fail closed when a package install in an executable surface does not
# use the lockfile with lifecycle scripts disabled (R-G3): every install must be
# `npm ci --ignore-scripts` (or the yarn/pnpm equivalent), so a compromised
# dependency's install hooks never run inside CI, the rubric, or gov-infra.
#
# Surface: the executable surfaces that can install packages in this repository
# are .github/workflows/**, scripts/**, gov-infra/** (verifier code, not the
# planning documents) and the Makefile. Documentation, templates and examples
# only describe installs; they are not install commands.
#
# Non-`ci` installs are only accepted when they install an immutable spec
# (an exact registry version, a packed tarball, or a file: path) or when they are
# one of the recorded, count-asserted exceptions below.
#
# Exit codes: 0 PASS, 1 FAIL (a violating install was found), 2 BLOCKED.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Only the generated apptheory-init scaffold may install without a lockfile: the
# generated project has none, its dependency set is pinned or a packed tarball,
# and the work tree is discarded after the check. The count assert below makes a
# silent removal or addition of that site fail this guard.
scaffold_exception_file="scripts/verify-scaffold-examples.sh"
scaffold_exception_line="npm install --ignore-scripts >/dev/null"
scaffold_exception_expected=3

# An install command is one that starts a command: at the beginning of a shell
# line (optionally after NAME=value assignments or sudo), or after a shell
# separator, optionally through a `cd DIR &&` prefix.
scan_re='(^|\(|&&|\|\||;|\|)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*(sudo[[:space:]]+)?(cd[[:space:]][^&|;()]*&&[[:space:]]*)?(npm[[:space:]]+(ci|install|i)|yarn([[:space:]]+(install|add))?|pnpm[[:space:]]+(install|i))([[:space:]]|$)'
ci_re='npm[[:space:]]+ci([[:space:]]|$)'
immutable_re='@[0-9]+\.[0-9]+\.[0-9]+'

joining_and_heredoc_awk='
BEGIN { in_heredoc = 0; heredoc_word = "" }
{
  if (in_heredoc) {
    if ($0 == heredoc_word) in_heredoc = 0
    next
  }
  buf = $0
  start = NR
  while (buf ~ /\\[[:space:]]*$/) {
    if ((getline nxt) > 0) { sub(/\\[[:space:]]*$/, "", buf); buf = buf nxt } else { break }
  }
  if (match(buf, heredoc_re)) {
    tok = substr(buf, RSTART, RLENGTH)
    sub(/^<<-?[[:space:]]*/, "", tok)
    gsub(quote_re, "", tok)
    if (tok != "") { heredoc_word = tok; in_heredoc = 1 }
  }
  printf "%d\t%s\n", start, buf
}
'

# classify_line <display-path> <lineno> <joined-line>
classify_line() {
  local display="$1"
  local lineno="$2"
  local line="$3"
  local trimmed
  trimmed="${line#"${line%%[![:space:]]*}"}"

  # Comments and message-emitting lines mention installs without running them.
  case "${trimmed}" in
    ''|\#*|echo*|printf*|:*|-\ *|\"*|\'*|f\"*|f\'*) return 0 ;;
  esac

  [[ "${line}" =~ ${scan_re} ]] || return 0

  if [[ "${line}" != *"--ignore-scripts"* ]]; then
    printf 'VIOLATION\t%s:%s\tinstall without --ignore-scripts\t%s\n' "${display}" "${lineno}" "${trimmed}"
    return 0
  fi

  if [[ "${display}" == "${scaffold_exception_file}" && "${trimmed}" == "${scaffold_exception_line}" ]]; then
    printf 'ALLOWED\t%s:%s\t%s\n' "${display}" "${lineno}" "${trimmed}"
    return 0
  fi

  [[ "${line}" =~ ${ci_re} ]] && return 0
  if [[ "${line}" =~ ${immutable_re} || "${line}" == *".tgz"* || "${line}" == *"file:"* ]]; then
    return 0
  fi

  printf 'VIOLATION\t%s:%s\tinstall without a lockfile or immutable spec\t%s\n' "${display}" "${lineno}" "${trimmed}"
}

scan_file() {
  local display="$1"
  awk -v heredoc_re="${heredoc_re}" -v quote_re="${quote_re}" "${joining_and_heredoc_awk}" "${display}" \
    | while IFS=$'\t' read -r lineno line; do
        classify_line "${display}" "${lineno}" "${line}"
      done
}

enumerate_surfaces() {
  git ls-files -z -- '.github/workflows' 'scripts' 'gov-infra' 'Makefile' \
    | tr '\0' '\n' \
    | { grep -Ev '^gov-infra/planning/' || true; } \
    | { grep -E '\.(sh|ya?ml)$|^Makefile$' || true; } \
    | LC_ALL=C sort
}

run_self_test() {
  local tmp work
  work="$(mktemp -d)"
  trap 'rm -rf "${work}"' RETURN

  mkdir -p "${work}/scripts"
  cat >"${work}/scripts/fixture-good.sh" <<'FIXTURE'
#!/usr/bin/env bash
(cd "${dir}/ts" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)
if ! (cd cdk && npm ci --ignore-scripts >/dev/null); then exit 1; fi
npm_config_loglevel=warn npm install --ignore-scripts --no-package-lock --prefix "${p}" release-please@17.1.3
echo "cdk-synth: FAIL (npm ci failed)"
cat <<'DOC'
- `npm i ./theory-cloud-apptheory-1.0.0.tgz`
DOC
FIXTURE

  cat >"${work}/scripts/fixture-bad-schools.sh" <<'FIXTURE'
#!/usr/bin/env bash
(cd ts && npm ci --no-audit --no-fund >/dev/null)
FIXTURE

  cat >"${work}/scripts/fixture-bad-lockfile.sh" <<'FIXTURE'
#!/usr/bin/env bash
(cd "${tmp}" && npm install --ignore-scripts >/dev/null)
FIXTURE

  cat >"${work}/scripts/fixture-bad-yarn.sh" <<'FIXTURE'
#!/usr/bin/env bash
(cd app && yarn install)
FIXTURE

  cat >"${work}/Makefile" <<'FIXTURE'
thing:
	@(cd ts && npm ci)
FIXTURE

  local output
  output="$(scan_file "${work}/scripts/fixture-good.sh")"
  if [[ -n "${output}" ]]; then
    echo "npm-install-hygiene self-test: FAIL (good fixture reported: ${output})" >&2
    return 1
  fi

  local schools lockfile yarn_make
  schools="$(scan_file "${work}/scripts/fixture-bad-schools.sh")"
  lockfile="$(scan_file "${work}/scripts/fixture-bad-lockfile.sh")"
  yarn_make="$(scan_file "${work}/scripts/fixture-bad-yarn.sh")$(scan_file "${work}/Makefile")"

  [[ "${schools}" == *"install without --ignore-scripts"* ]] || {
    echo "npm-install-hygiene self-test: FAIL (missing --ignore-scripts was not reported)" >&2
    return 1
  }
  [[ "${lockfile}" == *"install without a lockfile or immutable spec"* ]] || {
    echo "npm-install-hygiene self-test: FAIL (non-lockfile install was not reported)" >&2
    return 1
  }
  [[ "${yarn_make}" == *"install without --ignore-scripts"* ]] || {
    echo "npm-install-hygiene self-test: FAIL (yarn/Makefile installs were not reported)" >&2
    return 1
  }

  echo "npm-install-hygiene self-test: PASS"
}

heredoc_re="<<-?[[:space:]]*[\"']?[A-Za-z_][A-Za-z0-9_]*[\"']?"
quote_re="[\"']"

if [[ "${1:-}" == "--self-test" ]]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "npm-install-hygiene: BLOCKED (git not found)" >&2
    exit 2
  fi
  run_self_test
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  echo "npm-install-hygiene: BLOCKED (git not found)" >&2
  exit 2
fi

surfaces="$(enumerate_surfaces)"
if [[ -z "${surfaces}" ]]; then
  echo "npm-install-hygiene: BLOCKED (no executable surfaces found to scan)" >&2
  exit 2
fi

report=""
while IFS= read -r surface; do
  [[ -n "${surface}" ]] || continue
  report+="$(scan_file "${surface}")"$'\n'
done <<<"${surfaces}"

violations="$(grep -c $'^VIOLATION\t' <<<"${report}" || true)"
allowed="$(grep -c $'^ALLOWED\t' <<<"${report}" || true)"

if [[ "${violations}" -ne 0 ]]; then
  echo "npm-install-hygiene: FAIL (${violations} install(s) without --ignore-scripts or a lockfile)"
  grep $'^VIOLATION\t' <<<"${report}" | cut -f2- | sed 's/^/  /'
  exit 1
fi

if [[ "${allowed}" -ne "${scaffold_exception_expected}" ]]; then
  echo "npm-install-hygiene: FAIL (expected ${scaffold_exception_expected} recorded non-lockfile installs in ${scaffold_exception_file}, found ${allowed})" >&2
  grep $'^ALLOWED\t' <<<"${report}" | cut -f2- | sed 's/^/  /' >&2 || true
  exit 1
fi

echo "npm-install-hygiene: PASS (every scanned install uses a lockfile with scripts disabled; ${allowed} recorded scaffold exceptions)"
