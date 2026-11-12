#!/usr/bin/env bash
# Purpose: prove both release lanes generate release-driving fix-type release PR
# titles, release-branch commit subjects, and artifact sync commits, and that the
# generated messages cannot make an already-released range look release-eligible.
#
# Pinned release-please 17.11.2 uses the rendered release PR title as the
# release-branch commit message (build/src/manifest.js createOrUpdatePullRequest
# and build/src/github.js updatePullRequest). `pull-request-title-pattern` is
# therefore the single configuration key that changes both. The offline render
# proof that exercised the real library is recorded in the release-repair
# evidence; this verifier re-checks the live configuration and the workflow
# version-selection logic on every run.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
repo_root="$(pwd)"
classifier="${repo_root}/scripts/lib/release-automation-commits.py"
releasable_re='^(feat|fix|perf)(\([^)]+\))?(!)?: '

fail() {
  echo "release-generated-messages: FAIL ($1)" >&2
  exit 1
}

command -v python3 >/dev/null 2>&1 || fail "python3 is required"

# 1. Both lanes bind the same release-driving title pattern, still create draft
#    PRs, and keep the pinned release-please implementation.
for config in release-please-config.premain.json release-please-config.json; do
  grep -Fq '"pull-request-title-pattern": "fix${scope}: release${component} ${version}"' "${config}" ||
    fail "${config} must generate a fix-type release PR title and commit subject"
  grep -Fq '"draft": true' "${config}" ||
    fail "${config} must keep generated release PRs draft until the sync marks them ready"
done
grep -Fq 'release-please@17.11.2' scripts/stage-release-please-package.sh ||
  fail "the release PR wrapper must keep the pinned release-please implementation"
grep -Fq -- '--draft-pull-request' scripts/invoke-release-please-pr.mjs ||
  fail "the wrapper must keep generating draft release PRs"
grep -Fq 'release-please--branches--' scripts/run-release-please-pr.sh ||
  fail "the wrapper must keep the per-lane release branch contract"

# 2. The rendered titles and the artifact sync subject are release-driving, are
#    classified as already-released automation, and are never chore-typed.
expected_premain="$(python3 "${classifier}" render-title \
  --config release-please-config.premain.json --branch premain --version 7.3.0-rc)" ||
  fail "could not render the premain release PR title"
expected_stable="$(python3 "${classifier}" render-title \
  --config release-please-config.json --branch main --version 7.3.0)" ||
  fail "could not render the main release PR title"
sync_message="$(python3 "${classifier}" sync-message)" ||
  fail "could not read the generated artifact sync commit subject"

[[ "${expected_premain}" == "fix(premain): release 7.3.0-rc" ]] ||
  fail "premain title rendered as ${expected_premain}, expected fix(premain): release 7.3.0-rc"
[[ "${expected_stable}" == "fix(main): release 7.3.0" ]] ||
  fail "main title rendered as ${expected_stable}, expected fix(main): release 7.3.0"
[[ "${sync_message}" == "fix(release): sync generated release artifacts" ]] ||
  fail "artifact sync subject is ${sync_message}, expected the fix(release) message"

for subject in "${expected_premain}" "${expected_stable}" "${sync_message}"; do
  [[ "${subject}" =~ ${releasable_re} ]] ||
    fail "generated subject is not release-driving: ${subject}"
  python3 "${classifier}" is-automation --subject "${subject}" ||
    fail "generated subject is not classified as already-released automation: ${subject}"
  [[ "${subject}" != chore* ]] || fail "generated subject must never be chore-typed: ${subject}"
done

# 3. Generated automation alone never counts as fresh user-facing readiness.
for subject in "${expected_premain}" "${expected_stable}" "${sync_message}"; do
  if printf '%s\n' "${subject}" |
    python3 "${classifier}" filter-user-facing |
    grep -Eq "${releasable_re}"; then
    fail "generated automation subject was counted as user-facing readiness: ${subject}"
  fi
done
printf '%s\n' "fix(runtime): a genuinely user-facing repair" |
  python3 "${classifier}" filter-user-facing |
  grep -Eq "${releasable_re}" ||
  fail "a real fix commit must still count as user-facing readiness"

# 4. Every release predicate uses the shared classifier with the same predicate.
for script in \
  scripts/verify-release-eligibility.sh \
  scripts/verify-release-pr-postcondition.sh \
  scripts/verify-release-publish-postcondition.sh; do
  grep -Fq 'scripts/lib/release-automation-commits.py' "${script}" ||
    fail "${script} must exclude generated release-automation commits"
  grep -Fq '^(feat|fix|perf)(\([^)]+\))?(!)?: ' "${script}" ||
    fail "${script} must keep the release-driving subject predicate"
done
grep -Fq 'render-title' scripts/verify-release-pr-postcondition.sh ||
  fail "the release PR postcondition must bind the generated title to the lane config"
grep -Fq 'messageHeadline' scripts/verify-release-pr-postcondition.sh ||
  fail "the release PR postcondition must prove the release-branch commit subject"
grep -Fq -- '--release-as' scripts/run-release-please-pr.sh ||
  fail "the wrapper must keep the explicit release-as override for the stable lane"
if grep -Fq -- '--release-as' .github/workflows/prerelease-pr.yml; then
  fail "the premain lane must keep deriving its RC from the historical Release-As footer, not a workflow override"
fi

# 5. The stable lane's release-as computation selects the premain RC baseline.
python3 - <<'PY'
import json
import re
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

workflow = Path(".github/workflows/release-pr.yml").read_text(encoding="utf-8")
try:
    step = workflow.split("- name: Compute release-as (align to premain RC)", 1)[1]
    step = step.split("- name: Release Please (PR only) (aligned)", 1)[0]
    match = re.search(r"python3 - <<'PY'\n(.*?)\n\s*PY\n", step, re.DOTALL)
except IndexError:
    match = None
if match is None:
    raise SystemExit("release-generated-messages: FAIL (could not extract the stable release-as computation)")
snippet = textwrap.dedent(match.group(1))

cases = (
    ("7.1.0", "7.3.0-rc", "7.3.0"),
    ("7.1.0", "7.3.0-rc.1", "7.3.0"),
    ("7.1.0", "7.1.0", ""),
    ("7.3.0", "7.3.0-rc", ""),
    ("7.1.0", "8.0.0-rc", "8.0.0"),
)
for stable, premain, expected in cases:
    with tempfile.TemporaryDirectory(prefix="apptheory-release-as-") as tmp:
        root = Path(tmp)
        (root / ".release-please-manifest.json").write_text(
            json.dumps({".": stable}) + "\n", encoding="utf-8"
        )
        (root / ".release-please-manifest.premain.json").write_text(
            json.dumps({".": premain}) + "\n", encoding="utf-8"
        )
        result = subprocess.run(
            [sys.executable, "-c", snippet],
            cwd=root,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise SystemExit(
                "release-generated-messages: FAIL "
                f"(release-as computation failed for stable={stable} premain={premain}): {result.stderr.strip()}"
            )
        got = result.stdout.strip()
        if got != expected:
            raise SystemExit(
                "release-generated-messages: FAIL "
                f"(release-as for stable={stable} premain={premain} was {got!r}, expected {expected!r})"
            )
print("release-generated-messages: PASS (stable release-as selects the premain RC baseline)")
PY

# 6. Release topology: the generated fix-typed messages land inside the release
#    tag, so the next lane run sees no new commits and cannot self-trigger. A real
#    change after the tag is still visible.
tmp="$(mktemp -d "${TMPDIR:-/tmp}/apptheory-release-loop.XXXXXX")"
trap 'rm -rf "${tmp}"' EXIT
(
  cd "${tmp}"
  git init -q -b premain
  git config user.name "release-generated-messages self-test"
  git config user.email "release-generated-messages@example.invalid"
  git config commit.gpgsign false

  printf 'base\n' > marker.txt
  git add marker.txt
  git commit -q -m "chore: scaffold the RC line"

  printf 'release\n' >> marker.txt
  git commit -q -am "${expected_premain}"
  printf 'sync\n' >> marker.txt
  git commit -q -am "${sync_message}"
  git tag v7.3.0-rc

  tagged_subjects="$(git log --no-merges --format=%s v7.3.0-rc..HEAD)"
  if [[ -n "${tagged_subjects}" ]]; then
    echo "release-generated-messages: FAIL (generated commits self-triggered a new range after the tag)" >&2
    printf '%s\n' "${tagged_subjects}" >&2
    exit 1
  fi

  printf 'real\n' >> marker.txt
  git commit -q -am "fix(runtime): a genuinely new change"
  if ! git log --no-merges --format=%s v7.3.0-rc..HEAD |
    grep -Eq "${releasable_re}"; then
    echo "release-generated-messages: FAIL (a real change after the tag was not release-eligible)" >&2
    exit 1
  fi
)
echo "release-generated-messages: PASS (generated fix-type messages stay inside the release tag)"

echo "release-generated-messages: PASS"
