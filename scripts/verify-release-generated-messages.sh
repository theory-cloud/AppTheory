#!/usr/bin/env bash
# Purpose: prove both release lanes generate release-driving fix-type release PR
# titles, release-branch commit subjects, and artifact sync commits; prove the
# release PR postcondition binds those exact messages; and trace the actual
# workflow trigger and Release Please tag baseline that keeps a merged release PR
# from re-triggering generation.
#
# Pinned release-please 17.11.2 uses the rendered release PR title as the
# release-branch commit message (build/src/manifest.js createOrUpdatePullRequest
# and build/src/github.js updatePullRequest). `pull-request-title-pattern` is
# therefore the single configuration key that changes both. This verifier
# re-checks the live configuration and the workflow version-selection logic on
# every run; the offline render that exercised the real library is recorded in
# the ignored release-repair evidence.
#
# The release predicates do not classify generated commit subjects. Release
# Please makes its own decision from conventional commits and the tag baseline;
# the gates run after generation. The release-PR and publish no-op predicates
# measure from their immutable tags, while promotion eligibility evaluates only
# the range it is supplied. A generated commit remains a release-intended change
# wherever a predicate's own baseline does not already cover it.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
repo_root="$(pwd)"
helper="${repo_root}/scripts/lib/release-generated-messages.py"
releasable_re='^(feat|fix|perf)(\([^)]+\))?(!)?: '

fail() {
  echo "release-generated-messages: FAIL ($1)" >&2
  exit 1
}

command -v python3 >/dev/null 2>&1 || fail "python3 is required"

render_title() { # <config> <branch> <version>
  python3 "${helper}" render-title --config "$1" --branch "$2" --version "$3"
}

# 1. Both lanes bind the same release-driving title pattern, still create draft
#    PRs, and keep the pinned release-please implementation.
for config in release-please-config.premain.json release-please-config.json; do
  grep -Fq '"pull-request-title-pattern": "fix${scope}: release${component} ${version}"' "${config}" ||
    fail "${config} must generate a fix-type release PR title and commit subject"
  grep -Fq '"draft": true' "${config}" ||
    fail "${config} must keep the generated GitHub release draft until publish"
done
grep -Fq 'release-please@17.11.2' scripts/stage-release-please-package.sh ||
  fail "the release PR wrapper must keep the pinned release-please implementation"
grep -Fq -- '--draft-pull-request' scripts/invoke-release-please-pr.mjs ||
  fail "the wrapper must keep generating draft release PRs"
grep -Fq 'release-please--branches--' scripts/run-release-please-pr.sh ||
  fail "the wrapper must keep the per-lane release branch contract"

# 2. The rendered titles and the artifact sync subject are exact,
#    release-driving, and never chore-typed.
expected_premain="$(render_title release-please-config.premain.json premain 7.3.0-rc)" ||
  fail "could not render the premain release PR title"
expected_premain_numbered="$(render_title release-please-config.premain.json premain 7.3.0-rc.1)" ||
  fail "could not render a numbered premain release PR title"
expected_stable="$(render_title release-please-config.json main 7.3.0)" ||
  fail "could not render the main release PR title"
sync_message="$(python3 "${helper}" sync-message)" ||
  fail "could not read the generated artifact sync commit subject"

[[ "${expected_premain}" == "fix(premain): release 7.3.0-rc" ]] ||
  fail "premain title rendered as ${expected_premain}, expected fix(premain): release 7.3.0-rc"
[[ "${expected_premain_numbered}" == "fix(premain): release 7.3.0-rc.1" ]] ||
  fail "numbered premain title rendered as ${expected_premain_numbered}"
[[ "${expected_stable}" == "fix(main): release 7.3.0" ]] ||
  fail "main title rendered as ${expected_stable}, expected fix(main): release 7.3.0"
[[ "${sync_message}" == "fix(release): sync generated release artifacts" ]] ||
  fail "artifact sync subject is ${sync_message}, expected the fix(release) message"

for subject in "${expected_premain}" "${expected_premain_numbered}" "${expected_stable}" "${sync_message}"; do
  [[ "${subject}" =~ ${releasable_re} ]] ||
    fail "generated subject is not release-driving: ${subject}"
  [[ "${subject}" != chore* ]] || fail "generated subject must never be chore-typed: ${subject}"
done

# The scope is bound to the exact lane branch the postcondition passes, and the
# renderer accepts only strict stable/RC semver.
[[ "$(render_title release-please-config.premain.json main 7.3.0-rc)" == "fix(main): release 7.3.0-rc" ]] ||
  fail "the rendered scope must follow the exact lane branch"
for bad_version in 7.3 v7.3.0 7.3.0-rc.x 7.3.0.1; do
  if render_title release-please-config.premain.json premain "${bad_version}" >/dev/null 2>&1; then
    fail "the renderer accepted non-semver version ${bad_version}"
  fi
done

# 3. The release PR postcondition binds the exact generated title and proves the
#    release-branch commit subject. No release predicate classifies commit
#    subjects: a generated or lookalike fix is never exempted by its shape.
grep -Fq 'render-title' scripts/verify-release-pr-postcondition.sh ||
  fail "the release PR postcondition must bind the generated title to the lane config"
grep -Fq 'messageHeadline' scripts/verify-release-pr-postcondition.sh ||
  fail "the release PR postcondition must prove the release-branch commit subject"
grep -Fq '"fix(${base_branch}): "' scripts/verify-release-pr-postcondition.sh ||
  fail "the release PR postcondition must require the exact lane scope"
for predicate in \
  scripts/verify-release-eligibility.sh \
  scripts/verify-release-pr-postcondition.sh \
  scripts/verify-release-publish-postcondition.sh; do
  if grep -Eq 'filter-user-facing|release-automation-commits\.py|is-automation' "${predicate}"; then
    fail "${predicate} must not exempt commit subjects from release readiness"
  fi
done
for predicate in \
  scripts/verify-release-eligibility.sh \
  scripts/verify-release-pr-postcondition.sh \
  scripts/verify-release-publish-postcondition.sh; do
  grep -Fq '^(feat|fix|perf)(\([^)]+\))?(!)?: ' "${predicate}" ||
    fail "${predicate} must keep the release-driving subject predicate"
done
grep -Fq 'baseline_tag_from_manifest' scripts/verify-release-pr-postcondition.sh ||
  fail "the release PR no-op must be measured from the recorded manifest tag"
grep -Fq 'has_releasable_commits_since "${expected_tag}"' scripts/verify-release-publish-postcondition.sh ||
  fail "the publish no-op must be measured from the immutable published tag"
if grep -Fq 'git tag --list' scripts/verify-release-eligibility.sh; then
  fail "promotion eligibility must evaluate only its supplied range, not local tag names"
fi

# 4. The wrappers keep the explicit stable release-as override and the premain
#    lane keeps deriving its RC from the historical footer instead.
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

# 6. Trace the actual workflow trigger. A merged release PR pushes the generated
#    release artifacts listed in paths-ignore, so the generation workflow does
#    not start again from that push.
python3 - <<'PY'
from pathlib import Path


def paths_ignore(workflow: str) -> list[str]:
    text = Path(f".github/workflows/{workflow}").read_text(encoding="utf-8")
    try:
        block = text.split("    paths-ignore:\n", 1)[1]
    except IndexError:
        raise SystemExit(f"release-generated-messages: FAIL ({workflow} has no push paths-ignore)")
    entries = []
    for line in block.splitlines():
        stripped = line.strip()
        if not stripped.startswith("- "):
            break
        entries.append(stripped[2:].strip().strip('"'))
    return entries


premain_ignored = paths_ignore("prerelease-pr.yml")
stable_ignored = paths_ignore("release-pr.yml")
for workflow, ignored, required in (
    (
        "prerelease-pr.yml",
        premain_ignored,
        [".release-please-manifest.premain.json", "CHANGELOG.md", "VERSION", "cdk/.jsii", "py/pyproject.toml"],
    ),
    (
        "release-pr.yml",
        stable_ignored,
        [".release-please-manifest.json", "CHANGELOG.md", "VERSION", "cdk/.jsii", "py/pyproject.toml"],
    ),
):
    missing = [path for path in required if path not in ignored]
    if missing:
        raise SystemExit(
            f"release-generated-messages: FAIL ({workflow} push trigger does not ignore generated paths: {missing})"
        )
print("release-generated-messages: PASS (release artifact pushes are ignored by the generation workflows)")
PY

# 7. Prove the Release Please tag baseline: the generated release-branch commit
#    and the artifact sync commit land inside the tag created at the merged
#    release PR head, so a later run sees no new commits. A later generated fix,
#    like any new change, sits outside the tag and stays release-intended in the
#    predicates.
tmp="$(mktemp -d "${TMPDIR:-/tmp}/apptheory-release-baseline.XXXXXX")"
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

  git checkout -q -b release-please--branches--premain
  printf 'release\n' >> marker.txt
  git commit -q -am "${expected_premain}"
  generated_release_sha="$(git rev-parse HEAD)"
  printf 'sync\n' >> marker.txt
  git commit -q -am "${sync_message}"
  generated_sync_sha="$(git rev-parse HEAD)"

  git checkout -q premain
  git merge -q --no-ff release-please--branches--premain \
    -m "Merge pull request #9999 from theory-cloud/release-please--branches--premain"
  git tag v7.3.0-rc

  for generated_sha in "${generated_release_sha}" "${generated_sync_sha}"; do
    if ! git merge-base --is-ancestor "${generated_sha}" v7.3.0-rc; then
      echo "release-generated-messages: FAIL (a generated commit was not inside the release tag)" >&2
      exit 1
    fi
  done
  tagged_subjects="$(git log --no-merges --format=%s v7.3.0-rc..HEAD)"
  if [[ -n "${tagged_subjects}" ]]; then
    echo "release-generated-messages: FAIL (a new range exists after the release tag)" >&2
    printf '%s\n' "${tagged_subjects}" >&2
    exit 1
  fi

  printf 'real\n' >> marker.txt
  git commit -q -am "fix(runtime): a genuinely new change"
  if ! git log --no-merges --format=%s v7.3.0-rc..HEAD |
    grep -Eq "${releasable_re}"; then
    echo "release-generated-messages: FAIL (a real change after the tag was not release-intended)" >&2
    exit 1
  fi
)
echo "release-generated-messages: PASS (Release Please tag baseline excludes only tagged generated history)"

echo "release-generated-messages: PASS"
