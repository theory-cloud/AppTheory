#!/usr/bin/env bash
# Purpose: verify GitHub release workflows preserve the immutable release contract.
# --self-test runs the pairing-invocation attack battery without the rest of the pins.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

mode="verify"
case "${1:-}" in
  "") ;;
  --self-test) mode="self-test" ;;
  *)
    echo "usage: scripts/verify-release-workflows.sh [--self-test]" >&2
    exit 2
    ;;
esac

RELEASE_WORKFLOWS_MODE="${mode}" python3 - <<'PY'
import hashlib
import os
import re
import subprocess
from pathlib import Path

MODE = os.environ.get("RELEASE_WORKFLOWS_MODE", "verify")


def require_contains(path: str, needle: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    if needle not in text:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing {needle!r} in {path})")


def require_not_contains(path: str, needle: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    if needle in text:
        raise SystemExit(f"release-workflows: FAIL ({description}; unexpected {needle!r} in {path})")


def require_order(path: str, first: str, second: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    first_index = text.find(first)
    second_index = text.find(second)
    if first_index == -1:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing {first!r} in {path})")
    if second_index == -1:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing {second!r} in {path})")
    if first_index >= second_index:
        raise SystemExit(
            f"release-workflows: FAIL ({description}; {first!r} must appear before {second!r} in {path})"
        )


def require_order_after(path: str, anchor: str, first: str, second: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    anchor_index = text.find(anchor)
    if anchor_index == -1:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing anchor {anchor!r} in {path})")
    first_index = text.find(first, anchor_index)
    second_index = text.find(second, first_index if first_index != -1 else anchor_index)
    if first_index == -1:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing {first!r} after {anchor!r} in {path})")
    if second_index == -1:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing {second!r} after {first!r} in {path})")
    if first_index >= second_index:
        raise SystemExit(
            f"release-workflows: FAIL ({description}; {first!r} must appear before {second!r} after {anchor!r} in {path})"
        )


def require_step_contains(path: str, step_name: str, needle: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    marker = f"      - name: {step_name}\n"
    start_index = text.find(marker)
    if start_index == -1:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing step {step_name!r} in {path})")
    next_step_index = text.find("\n      - ", start_index + len(marker))
    block = text[start_index : next_step_index if next_step_index != -1 else len(text)]
    if needle not in block:
        raise SystemExit(
            f"release-workflows: FAIL ({description}; missing {needle!r} in step {step_name!r} of {path})"
        )


def require_job_contains(path: str, job_name: str, needle: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    match = re.search(
        rf"(?ms)^  {re.escape(job_name)}[ \t]*:\n(?P<block>.*?)(?=^  [A-Za-z0-9_-]+[ \t]*:\n|\Z)",
        text,
    )
    if match is None or needle not in match.group("block"):
        raise SystemExit(
            f"release-workflows: FAIL ({description}; missing {needle!r} in job {job_name!r} of {path})"
        )


# ---------------------------------------------------------------------------
# The guarded surface, pinned by exact bytes.
#
# Rounds 1-4 classified the guarded wiring instead: they modelled bash's quote
# contexts, bash's function bodies and YAML's key spellings, and admitted an
# extra statement they judged inert. Every round found a spelling the model
# lacked, and the last round found that the admission rule itself was the hole -
# an `exit 0` written as the first line of a pinned run body leaves every pinned
# statement in place and stops the gate from ever mattering.
#
# So there is no model and no admission rule here. Every guarded region is
# pinned by exact bytes. The only tolerated drift is trailing whitespace on a
# line and a CRLF line ending, so an ordinary editor does not trip the guard;
# anything else is a finding with no parsing involved.
#
# The posture this buys: an intentional change to a guarded region is a visible
# two-place edit - the region and the pin that describes it - in the same
# commit. What is *not* pinned anywhere in this repository is stated in
# docs/release-process.md, together with the reason it is not.
# ---------------------------------------------------------------------------

GUARDED_BASENAMES = ("verify-release-pairing.sh", "verify-release-workflows.sh")

GUARDED_WORKFLOWS = (
    ".github/workflows/ci.yml",
    ".github/workflows/prerelease-pr.yml",
    ".github/workflows/release-pr.yml",
    ".github/workflows/prerelease.yml",
    ".github/workflows/release.yml",
)

GUARDED_INVOKERS = (
    "scripts/verify-release-branch.sh",
    "scripts/verify-release-publish-postcondition.sh",
    "scripts/verify-release-gates.sh",
    "gov-infra/verifiers/gov-verify-rubric.sh",
)

GOV_VERIFIER = "gov-infra/verifiers/gov-verify-rubric.sh"

# Two places outside the pinned files that could gain a call site. `Makefile` and
# a root `package.json` are read when present; `.github/**` is walked rather than
# enumerated, so a new workflow file or a new composite action is read too.
# Neither file names a guarded script today and there is no `.github/actions/`
# directory; the occurrence sweep below is what keeps that true.
SWEEP_EXTRA_FILES = ("Makefile", "package.json")


def sweep_paths():
    """Every file the occurrence sweep reads for a guarded script name."""
    paths = []
    github = Path(".github")
    if github.is_dir():
        paths.extend(str(path) for path in sorted(github.rglob("*")) if path.is_file())
    paths.extend(extra for extra in SWEEP_EXTRA_FILES if Path(extra).is_file())
    paths.extend(path for path in GUARDED_INVOKERS if path not in paths)
    return tuple(paths)


# ---------------------------------------------------------------------------
# Pins.
# ---------------------------------------------------------------------------

# The workflow-level configuration above `jobs:` - `on:`, `permissions:`,
# `concurrency:`, `env:`, `defaults:` and anything else the owner adds - is
# resolved by the runner before any step below it, so it is pinned whole.
WORKFLOW_PREAMBLE_PINS = {
    '.github/workflows/ci.yml': (
        'name: CI',
        '',
        'on:',
        '  pull_request:',
        '    types: [opened, synchronize, reopened, ready_for_review]',
        '  push:',
        '    branches:',
        '      - staging',
        '      - main',
        '      - premain',
        '  workflow_dispatch:',
        '    inputs:',
        '      run_full_rubric:',
        '        description: "Run Rubric (full gate set)"',
        '        required: false',
        '        type: boolean',
        '        default: true',
        '      release_pr_number:',
        '        description: "Generated release PR number for head-bound release checks"',
        '        required: false',
        '        type: string',
        '        default: ""',
        '',
        'permissions:',
        '  contents: read',
        '  pull-requests: read',
    ),
    '.github/workflows/prerelease-pr.yml': (
        'name: Prerelease PR (premain)',
        '',
        'on:',
        '  push:',
        '    branches: ["premain"]',
        '    paths-ignore:',
        '      - ".release-please-manifest.premain.json"',
        '      - "CHANGELOG.md"',
        '      - "VERSION"',
        '      - "ts/package.json"',
        '      - "ts/package-lock.json"',
        '      - "cdk/package.json"',
        '      - "cdk/package-lock.json"',
        '      - "cdk/.jsii"',
        '      - "py/pyproject.toml"',
        '      - "examples/cdk/multilang/package-lock.json"',
        '      - "examples/cdk/ssr-site/package-lock.json"',
        '      - "examples/cdk/lesser-parity/package-lock.json"',
        '  workflow_dispatch: {}',
        '',
        'permissions:',
        '  actions: write',
        '  contents: write',
        '  issues: write',
        '  pull-requests: write',
        '',
        'concurrency:',
        '  group: release-pr-${{ github.repository }}-release-please--branches--premain',
        '  cancel-in-progress: false',
    ),
    '.github/workflows/release-pr.yml': (
        'name: Release PR (main)',
        '',
        'on:',
        '  push:',
        '    branches: ["main"]',
        '    paths-ignore:',
        '      - ".release-please-manifest.json"',
        '      - "CHANGELOG.md"',
        '      - "VERSION"',
        '      - "ts/package.json"',
        '      - "ts/package-lock.json"',
        '      - "cdk/package.json"',
        '      - "cdk/package-lock.json"',
        '      - "cdk/.jsii"',
        '      - "py/pyproject.toml"',
        '      - "examples/cdk/multilang/package-lock.json"',
        '      - "examples/cdk/ssr-site/package-lock.json"',
        '      - "examples/cdk/lesser-parity/package-lock.json"',
        '  workflow_dispatch: {}',
        '',
        'permissions:',
        '  actions: write',
        '  contents: write',
        '  issues: write',
        '  pull-requests: write',
        '',
        'concurrency:',
        '  group: release-pr-${{ github.repository }}-release-please--branches--main',
        '  cancel-in-progress: false',
    ),
    '.github/workflows/prerelease.yml': (
        'name: Prerelease (premain)',
        '',
        'on:',
        '  push:',
        '    branches: ["premain"]',
        '  workflow_dispatch: {}',
        '',
        'concurrency:',
        '  group: release-publisher-${{ github.repository }}',
        '  cancel-in-progress: false',
        '',
        'permissions:',
        '  contents: write',
        '  issues: write',
        '  pull-requests: write',
    ),
    '.github/workflows/release.yml': (
        'name: Release (main)',
        '',
        'on:',
        '  push:',
        '    branches: ["main"]',
        '  workflow_dispatch:',
        '    inputs:',
        '      tag_name:',
        '        description: "Optional: upload assets to an existing tag\'s *draft* release (fails if already published/immutable) (e.g., v0.2.0)"',
        '        required: false',
        '',
        'concurrency:',
        '  group: release-publisher-${{ github.repository }}',
        '  cancel-in-progress: false',
        '',
        'permissions:',
        '  contents: write',
        '  issues: write',
        '  pull-requests: write',
    ),
}

# Every raw line of a guarded job between its key line and its first step. This
# is where the job's own `if:` lives - pinned whether it is present with exactly
# these bytes or absent, which is the same pin as the absence of those bytes -
# and where `continue-on-error:`, `env:`, `defaults:` and any key this guard
# does not enumerate live. Reached before the step below it runs, so it is
# pinned whole rather than key by key.
JOB_PINS = {
    ('.github/workflows/ci.yml', 'release-security-gates'): (
        '  release-security-gates:',
        '    name: Release/security gates',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
        '        with:',
        '          fetch-depth: 0',
        '          persist-credentials: false',
        '      - name: Verify release/security invariants',
        '        env:',
        '          GH_TOKEN: ${{ github.token }}',
        '          GITHUB_TOKEN: ${{ github.token }}',
        '          PR_BASE_REF: ${{ github.event.pull_request.base.ref }}',
        '          PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
        '        run: |',
        '          bash scripts/verify-branch-release-supply-chain.sh',
        '          bash scripts/verify-release-branch-signatures.sh',
        '          bash scripts/verify-release-train-promotion.sh --self-test',
        '          bash scripts/verify-ci-rubric-enforced.sh',
        '          bash scripts/verify-release-workflows.sh',
        '          bash scripts/verify-release-cycle.sh',
        '      - name: Verify runtime floor claims',
        '        run: bash scripts/verify-runtime-floor-claims.sh',
        '      - uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0',
        '        with:',
        '          go-version: "1.26.6"',
        '      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
        '        with:',
        '          node-version: "24"',
        '      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0',
        '        with:',
        '          python-version: "3.14"',
        '      - name: Verify apptheory-init template/release pairing',
        '        run: |',
        '          bash scripts/verify-release-pairing.sh --self-test',
        '          bash scripts/verify-release-pairing.sh',
    ),
    ('.github/workflows/prerelease-pr.yml', 'release-please'): (
        '  release-please:',
        "    if: github.event_name == 'workflow_dispatch' || !contains(github.event.head_commit.message, 'release-please--branches--premain')",
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Checkout',
        '        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
        '',
        '      - name: Verify branch version sync before release PR',
        '        run: scripts/verify-branch-version-sync.sh',
        '',
        '      - name: Release Please (PR only)',
        '        id: release',
        '        env:',
        '          RELEASE_PLEASE_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '        run: |',
        '          # Wrapper stages release-please@17.1.3 without credentials in npm and',
        '          # invokes its parser in-process with an environment-only token. It',
        '          # always applies --draft-pull-request internally.',
        '          scripts/run-release-please-pr.sh \\',
        '            --target-branch premain \\',
        '            --config-file release-please-config.premain.json \\',
        '            --manifest-file .release-please-manifest.premain.json',
        '',
        '      - name: Verify generated RC release PR postcondition',
        '        env:',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '        run: scripts/verify-release-pr-postcondition.sh prerelease',
        '',
        '      - name: Detect open release PR',
        '        id: release_pr',
        '        env:',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '        run: |',
        '          pr_number="$(',
        '            gh pr list \\',
        '              --state open \\',
        '              --base premain \\',
        '              --head release-please--branches--premain \\',
        '              --json number \\',
        '              --jq \'.[0].number // ""\'',
        '          )"',
        '          if [[ -n "${pr_number}" ]]; then',
        '            echo "exists=true" >> "${GITHUB_OUTPUT}"',
        '            echo "number=${pr_number}" >> "${GITHUB_OUTPUT}"',
        '          else',
        '            echo "exists=false" >> "${GITHUB_OUTPUT}"',
        '          fi',
        '',
        '      - name: Draft-lock release PR before artifact setup',
        "        if: steps.release_pr.outputs.exists == 'true'",
        '        env:',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '          RELEASE_PR_NUMBER: ${{ steps.release_pr.outputs.number }}',
        '        run: |',
        '          set -euo pipefail',
        '',
        '          is_draft="$(gh pr view "${RELEASE_PR_NUMBER}" --json isDraft --jq \'.isDraft\')"',
        '          if [[ "${is_draft}" != "true" ]]; then',
        '            gh pr ready "${RELEASE_PR_NUMBER}" --undo',
        '          fi',
        '',
        '          is_draft="$(gh pr view "${RELEASE_PR_NUMBER}" --json isDraft --jq \'.isDraft\')"',
        '          if [[ "${is_draft}" != "true" ]]; then',
        '            echo "release-pr: FAIL (PR #${RELEASE_PR_NUMBER} could not be draft-locked before artifact setup)" >&2',
        '            exit 1',
        '          fi',
        '',
        '      - uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0',
        "        if: steps.release_pr.outputs.exists == 'true'",
        '        with:',
        '          go-version: "1.26.6"',
        '',
        '      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
        "        if: steps.release_pr.outputs.exists == 'true'",
        '        with:',
        '          node-version: "24.13.1"',
        '',
        '      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0',
        "        if: steps.release_pr.outputs.exists == 'true'",
        '        with:',
        '          python-version: "3.14"',
        '',
        '      - name: Verify apptheory-init template/release pairing',
        "        if: steps.release_pr.outputs.exists == 'true'",
        '        run: |',
        '          bash scripts/verify-release-pairing.sh --self-test',
        '          bash scripts/verify-release-pairing.sh',
        '',
        '      - name: Sync generated CDK artifacts on release PR',
        "        if: steps.release_pr.outputs.exists == 'true'",
        '        env:',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '        run: scripts/sync-release-pr-generated.sh release-please--branches--premain',
    ),
    ('.github/workflows/release-pr.yml', 'release-please'): (
        '  release-please:',
        "    if: github.event_name == 'workflow_dispatch' || !contains(github.event.head_commit.message, 'release-please--branches--main')",
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Checkout',
        '        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
        '',
        '      - name: Check recorded stable release',
        '        id: stable_release',
        '        env:',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '        run: |',
        '          set -euo pipefail',
        '',
        '          stable="$(',
        "            python3 - <<'PY'",
        '          import json',
        '          from pathlib import Path',
        '',
        '          version = json.loads(Path(".release-please-manifest.json").read_text(encoding="utf-8")).get(".", "")',
        '          if not version:',
        '              raise SystemExit("missing stable release version")',
        '          print(version)',
        '          PY',
        '          )"',
        '',
        '          tag="v${stable}"',
        '          echo "tag=${tag}" >> "${GITHUB_OUTPUT}"',
        '',
        '          if gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/${tag}" >/dev/null 2>&1; then',
        '            echo "blocked=false" >> "${GITHUB_OUTPUT}"',
        '            echo "stable-release: PASS (${tag} tag exists)"',
        '            exit 0',
        '          fi',
        '',
        '          echo "blocked=false" >> "${GITHUB_OUTPUT}"',
        '          echo "stable-release: WARN (${tag} tag is missing; next Release PR must be forced from the premain RC baseline)"',
        '          {',
        '            echo "### Stable release tag missing"',
        '            echo ""',
        '            echo "\\`${tag}\\` is recorded in \\`.release-please-manifest.json\\`,"',
        '            echo "but \\`refs/tags/${tag}\\` does not exist."',
        '            echo "Release PR generation will continue only through the premain RC"',
        '            echo "baseline so the next stable version stays on the patch line."',
        '          } >> "${GITHUB_STEP_SUMMARY}"',
        '',
        '      - name: Compute release-as (align to premain RC)',
        "        if: steps.stable_release.outputs.blocked != 'true'",
        '        id: version',
        '        run: |',
        '          set -euo pipefail',
        '',
        '          release_as="$(',
        "            python3 - <<'PY'",
        '          import json',
        '          from pathlib import Path',
        '',
        '',
        '          def parse_base(v: str) -> tuple[int, int, int]:',
        '              v = v.strip()',
        '              if v.startswith("v"):',
        '                  v = v[1:]',
        '              v = v.split("+", 1)[0]',
        '              base = v.split("-", 1)[0]',
        '              parts = base.split(".")',
        '              if len(parts) != 3:',
        '                  raise ValueError(f"invalid semver base: {v}")',
        '              return (int(parts[0]), int(parts[1]), int(parts[2]))',
        '',
        '',
        '          stable = json.loads(Path(".release-please-manifest.json").read_text(encoding="utf-8")).get(".", "")',
        '          premain = json.loads(Path(".release-please-manifest.premain.json").read_text(encoding="utf-8")).get(".", "")',
        '',
        '          if not stable or not premain:',
        '              raise SystemExit("")',
        '',
        '          premain_base = premain.split("+", 1)[0].split("-", 1)[0]',
        '',
        '          # If premain is already on a higher major/minor/patch line (e.g., 0.5.0-rc.1),',
        '          # force the stable Release PR to promote that baseline (e.g., 0.5.0).',
        '          if parse_base(premain_base) > parse_base(stable):',
        '              print(premain_base)',
        '          PY',
        '          )"',
        '',
        '          echo "release_as=${release_as}" >> "${GITHUB_OUTPUT}"',
        '          echo "release-as: ${release_as:-}"',
        '',
        '      - name: Release Please (PR only) (aligned)',
        "        if: steps.stable_release.outputs.blocked != 'true' && steps.version.outputs.release_as != ''",
        '        id: release_aligned',
        '        env:',
        '          RELEASE_PLEASE_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '          RELEASE_AS: ${{ steps.version.outputs.release_as }}',
        '        run: |',
        '          # NOTE: release-please-action currently does not apply `release-as` when using',
        '          # `config-file`+`manifest-file` (manifest mode). Use the CLI so the stable',
        '          # release PR can be forced to the premain RC baseline.',
        '          # Wrapper stages release-please@17.1.3 without credentials in npm and',
        '          # invokes its parser in-process with an environment-only token. It',
        '          # always applies --draft-pull-request internally.',
        '          scripts/run-release-please-pr.sh \\',
        '            --target-branch main \\',
        '            --config-file release-please-config.json \\',
        '            --manifest-file .release-please-manifest.json \\',
        '            --release-as "${RELEASE_AS}"',
        '',
        '      - name: Release Please (PR only)',
        "        if: steps.stable_release.outputs.blocked != 'true' && steps.version.outputs.release_as == ''",
        '        id: release_default',
        '        env:',
        '          RELEASE_PLEASE_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '        run: |',
        '          # Wrapper stages release-please@17.1.3 without credentials in npm and',
        '          # invokes its parser in-process with an environment-only token. It',
        '          # always applies --draft-pull-request internally.',
        '          scripts/run-release-please-pr.sh \\',
        '            --target-branch main \\',
        '            --config-file release-please-config.json \\',
        '            --manifest-file .release-please-manifest.json',
        '',
        '      - name: Verify generated stable release PR postcondition',
        "        if: steps.stable_release.outputs.blocked != 'true'",
        '        env:',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '        run: scripts/verify-release-pr-postcondition.sh stable',
        '',
        '      - name: Detect open release PR',
        "        if: steps.stable_release.outputs.blocked != 'true'",
        '        id: release_pr',
        '        env:',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '        run: |',
        '          pr_number="$(',
        '            gh pr list \\',
        '              --state open \\',
        '              --base main \\',
        '              --head release-please--branches--main \\',
        '              --json number \\',
        '              --jq \'.[0].number // ""\'',
        '          )"',
        '          if [[ -n "${pr_number}" ]]; then',
        '            echo "exists=true" >> "${GITHUB_OUTPUT}"',
        '            echo "number=${pr_number}" >> "${GITHUB_OUTPUT}"',
        '          else',
        '            echo "exists=false" >> "${GITHUB_OUTPUT}"',
        '          fi',
        '',
        '      - name: Draft-lock release PR before artifact setup',
        "        if: steps.release_pr.outputs.exists == 'true'",
        '        env:',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '          RELEASE_PR_NUMBER: ${{ steps.release_pr.outputs.number }}',
        '        run: |',
        '          set -euo pipefail',
        '',
        '          is_draft="$(gh pr view "${RELEASE_PR_NUMBER}" --json isDraft --jq \'.isDraft\')"',
        '          if [[ "${is_draft}" != "true" ]]; then',
        '            gh pr ready "${RELEASE_PR_NUMBER}" --undo',
        '          fi',
        '',
        '          is_draft="$(gh pr view "${RELEASE_PR_NUMBER}" --json isDraft --jq \'.isDraft\')"',
        '          if [[ "${is_draft}" != "true" ]]; then',
        '            echo "release-pr: FAIL (PR #${RELEASE_PR_NUMBER} could not be draft-locked before artifact setup)" >&2',
        '            exit 1',
        '          fi',
        '',
        '      - uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0',
        "        if: steps.release_pr.outputs.exists == 'true'",
        '        with:',
        '          go-version: "1.26.6"',
        '',
        '      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
        "        if: steps.release_pr.outputs.exists == 'true'",
        '        with:',
        '          node-version: "24.13.1"',
        '',
        '      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0',
        "        if: steps.release_pr.outputs.exists == 'true'",
        '        with:',
        '          python-version: "3.14"',
        '',
        '      - name: Verify apptheory-init template/release pairing',
        "        if: steps.release_pr.outputs.exists == 'true'",
        '        run: |',
        '          bash scripts/verify-release-pairing.sh --self-test',
        '          bash scripts/verify-release-pairing.sh',
        '',
        '      - name: Sync generated CDK artifacts on release PR',
        "        if: steps.release_pr.outputs.exists == 'true'",
        '        env:',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '        run: scripts/sync-release-pr-generated.sh release-please--branches--main',
    ),
    ('.github/workflows/prerelease.yml', 'release-please'): (
        '  release-please:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Checkout (release preflight)',
        '        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
        '        with:',
        '          fetch-depth: 0',
        '',
        '      - name: Fetch main + premain (release preflight)',
        '        run: git fetch origin main premain --force',
        '',
        '      - name: Verify branch version sync (release preflight)',
        '        run: scripts/verify-branch-version-sync.sh',
        '',
        '      - name: Verify release supply chain (release preflight)',
        '        run: bash scripts/verify-branch-release-supply-chain.sh',
        '',
        '      - uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0',
        '        with:',
        '          go-version: "1.26.6"',
        '',
        '      - name: Verify release workflow invariants (release preflight)',
        '        run: bash scripts/verify-release-workflows.sh',
        '',
        '      - name: Set SOURCE_DATE_EPOCH (release preflight)',
        '        run: echo "SOURCE_DATE_EPOCH=$(git show -s --format=%ct HEAD)" >> "$GITHUB_ENV"',
        '',
        '      - name: Install golangci-lint (pinned) (release preflight)',
        '        run: go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.9.0',
        '',
        '      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
        '        with:',
        '          node-version: "24.13.1"',
        '',
        '      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0',
        '        with:',
        '          python-version: "3.14.3"',
        '',
        '      - name: Release Please (Prerelease)',
        '        id: release',
        '        uses: googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7 # v5.0.0',
        '        with:',
        '          token: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '          target-branch: premain',
        '          config-file: release-please-config.premain.json',
        '          manifest-file: .release-please-manifest.premain.json',
        '          # Prevent release-please from opening the *next* prerelease PR on release commits.',
        '          # PR generation runs in prerelease-pr.yml.',
        '          skip-github-pull-request: true',
        '',
        '      - name: Verify prerelease publish postcondition',
        '        env:',
        '          RELEASE_CREATED: ${{ steps.release.outputs.release_created }}',
        '          TAG_NAME: ${{ steps.release.outputs.tag_name }}',
        '        run: scripts/verify-release-publish-postcondition.sh prerelease "${RELEASE_CREATED}" "${TAG_NAME}" prepublish',
        '',
        '      - name: Build, upload, and publish prerelease assets',
        "        if: steps.release.outputs.release_created == 'true'",
        '        env:',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '          TAG_NAME: ${{ steps.release.outputs.tag_name }}',
        '        run: scripts/publish-release-assets.sh "${TAG_NAME}"',
        '',
        '      - name: Recover or verify existing prerelease',
        "        if: steps.release.outputs.release_created != 'true'",
        '        env:',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '        run: |',
        '          TAG_NAME="v$(./scripts/read-version.sh)"',
        '          if [[ ! "${TAG_NAME}" =~ -rc(\\.|$) ]]; then',
        '            echo "release-assets: SKIP (${TAG_NAME} is not a prerelease tag)"',
        '            exit 0',
        '          fi',
        '',
        '          if ! gh release view "${TAG_NAME}" >/dev/null 2>&1; then',
        '            echo "release-assets: SKIP (${TAG_NAME} has no release to recover or verify)"',
        '            exit 0',
        '          fi',
        '',
        '          scripts/publish-release-assets.sh "${TAG_NAME}"',
        '',
        '      - name: Verify prerelease publication closure',
        '        env:',
        '          RELEASE_CREATED: ${{ steps.release.outputs.release_created }}',
        '          TAG_NAME: ${{ steps.release.outputs.tag_name }}',
        '        run: scripts/verify-release-publish-postcondition.sh prerelease "${RELEASE_CREATED}" "${TAG_NAME}" complete',
        '',
        '      - name: Diagnose failed prerelease state (read-only)',
        '        if: failure()',
        '        env:',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '          TAG_NAME: ${{ steps.release.outputs.tag_name }}',
        '        run: |',
        '          if [[ -z "${TAG_NAME}" ]]; then',
        '            TAG_NAME="v$(./scripts/read-version.sh)"',
        '          fi',
        '',
        '          export TAG_NAME',
        '          scripts/diagnose-release-state.sh --tag "${TAG_NAME}"',
    ),
    ('.github/workflows/release.yml', 'release-please'): (
        '  release-please:',
        '    runs-on: ubuntu-latest',
        '    outputs:',
        '      release_created: ${{ steps.release.outputs.release_created }}',
        '      tag_name: ${{ steps.release.outputs.tag_name }}',
        '    steps:',
        '      - name: Checkout (for tag-triggered assets)',
        "        if: startsWith(github.ref, 'refs/tags/') || inputs.tag_name != ''",
        '        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
        '        with:',
        '          fetch-depth: 0',
        '          # The publish script resolves and checks out the immutable tag or draft-release target.',
        '',
        '      - name: Checkout (stable release preflight)',
        "        if: github.ref == 'refs/heads/main' && inputs.tag_name == ''",
        '        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
        '        with:',
        '          fetch-depth: 0',
        '',
        '      - name: Fetch main + premain (stable release preflight)',
        "        if: github.ref == 'refs/heads/main' && inputs.tag_name == ''",
        '        run: git fetch origin main premain --force',
        '',
        '      - name: Verify branch version sync (stable release preflight)',
        "        if: github.ref == 'refs/heads/main' && inputs.tag_name == ''",
        '        run: scripts/verify-branch-version-sync.sh',
        '',
        '      - name: Verify release supply chain (stable release preflight)',
        "        if: github.ref == 'refs/heads/main' && inputs.tag_name == ''",
        '        run: bash scripts/verify-branch-release-supply-chain.sh',
        '',
        '      - uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0',
        "        if: github.ref == 'refs/heads/main' && inputs.tag_name == ''",
        '        with:',
        '          go-version: "1.26.6"',
        '',
        '      - name: Verify release workflow invariants (stable release preflight)',
        "        if: github.ref == 'refs/heads/main' && inputs.tag_name == ''",
        '        run: bash scripts/verify-release-workflows.sh',
        '',
        '      - name: Set SOURCE_DATE_EPOCH (stable release preflight)',
        "        if: github.ref == 'refs/heads/main' && inputs.tag_name == ''",
        '        run: echo "SOURCE_DATE_EPOCH=$(git show -s --format=%ct HEAD)" >> "$GITHUB_ENV"',
        '',
        '      - name: Install golangci-lint (pinned) (stable release preflight)',
        "        if: github.ref == 'refs/heads/main' && inputs.tag_name == ''",
        '        run: go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.9.0',
        '',
        '      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
        "        if: github.ref == 'refs/heads/main' && inputs.tag_name == ''",
        '        with:',
        '          node-version: "24.13.1"',
        '',
        '      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0',
        "        if: github.ref == 'refs/heads/main' && inputs.tag_name == ''",
        '        with:',
        '          python-version: "3.14.3"',
        '',
        '      - uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0',
        "        if: startsWith(github.ref, 'refs/tags/') || inputs.tag_name != ''",
        '        with:',
        '          go-version: "1.26.6"',
        '',
        '      - name: Install golangci-lint (pinned) (for tag-triggered assets)',
        "        if: startsWith(github.ref, 'refs/tags/') || inputs.tag_name != ''",
        '        run: go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.9.0',
        '',
        '      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
        "        if: startsWith(github.ref, 'refs/tags/') || inputs.tag_name != ''",
        '        with:',
        '          node-version: "24.13.1"',
        '',
        '      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0',
        "        if: startsWith(github.ref, 'refs/tags/') || inputs.tag_name != ''",
        '        with:',
        '          python-version: "3.14.3"',
        '',
        '      - name: Upload assets for existing tag release',
        "        if: startsWith(github.ref, 'refs/tags/') || inputs.tag_name != ''",
        '        env:',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '          TAG_NAME: ${{ inputs.tag_name || github.ref_name }}',
        '        run: scripts/publish-release-assets.sh "${TAG_NAME}"',
        '',
        '      - name: Release Please (Stable)',
        '        id: release',
        "        if: github.ref == 'refs/heads/main' && inputs.tag_name == ''",
        '        uses: googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7 # v5.0.0',
        '        with:',
        '          token: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '          target-branch: main',
        '          config-file: release-please-config.json',
        '          manifest-file: .release-please-manifest.json',
        '          # Prevent release-please from opening the *next* release PR on release commits.',
        '          # PR generation runs in release-pr.yml.',
        '          skip-github-pull-request: true',
        '',
        '      - name: Verify stable publish postcondition',
        "        if: github.ref == 'refs/heads/main' && inputs.tag_name == ''",
        '        env:',
        '          RELEASE_CREATED: ${{ steps.release.outputs.release_created }}',
        '          TAG_NAME: ${{ steps.release.outputs.tag_name }}',
        '        run: scripts/verify-release-publish-postcondition.sh stable "${RELEASE_CREATED}" "${TAG_NAME}" prepublish',
        '',
        '      - name: Build, upload, and publish release assets',
        "        if: steps.release.outputs.release_created == 'true'",
        '        env:',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '          TAG_NAME: ${{ steps.release.outputs.tag_name }}',
        '        run: scripts/publish-release-assets.sh "${TAG_NAME}"',
        '',
        '      - name: Recover or verify existing stable release',
        "        if: github.ref == 'refs/heads/main' && inputs.tag_name == '' && steps.release.outputs.release_created != 'true'",
        '        env:',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '        run: |',
        '          TAG_NAME="v$(./scripts/read-version.sh)"',
        '          if [[ "${TAG_NAME}" =~ -rc(\\.|$) ]]; then',
        '            echo "release-assets: SKIP (${TAG_NAME} is not a stable tag)"',
        '            exit 0',
        '          fi',
        '',
        '          if ! gh release view "${TAG_NAME}" >/dev/null 2>&1; then',
        '            echo "release-assets: SKIP (${TAG_NAME} has no release to recover or verify)"',
        '            exit 0',
        '          fi',
        '',
        '          scripts/publish-release-assets.sh "${TAG_NAME}"',
        '',
        '      - name: Verify stable publication closure',
        "        if: github.ref == 'refs/heads/main' && inputs.tag_name == ''",
        '        env:',
        '          RELEASE_CREATED: ${{ steps.release.outputs.release_created }}',
        '          TAG_NAME: ${{ steps.release.outputs.tag_name }}',
        '        run: scripts/verify-release-publish-postcondition.sh stable "${RELEASE_CREATED}" "${TAG_NAME}" complete',
        '',
        '      - name: Diagnose failed release state (read-only)',
        '        if: failure()',
        '        env:',
        '          GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
        '          TAG_NAME: ${{ inputs.tag_name || steps.release.outputs.tag_name }}',
        '        run: |',
        '          if [[ -z "${TAG_NAME}" && "${GITHUB_REF:-}" == refs/tags/* ]]; then',
        '            TAG_NAME="${GITHUB_REF_NAME}"',
        '          fi',
        '',
        '          if [[ -z "${TAG_NAME}" ]]; then',
        '            TAG_NAME="v$(./scripts/read-version.sh)"',
        '          fi',
        '',
        '          export TAG_NAME',
        '          scripts/diagnose-release-state.sh --tag "${TAG_NAME}"',
        '',
        '  # Hands docs publication off to pages.yml. Releases are published with the',
        '  # default GITHUB_TOKEN, whose events can never trigger other workflows —',
        '  # but workflow_dispatch is explicitly allowed, so this job dispatches',
        '  # pages.yml on the just-published tag instead of relying on release events.',
        '  # Runs only after the release-please job (including asset publish and the',
        '  # publication-closure postcondition) has completed successfully.',
    ),
}

# Each guarded step, whole: its name, every key it carries (`if:`, `env:`,
# `shell:`, `run:` and any other), and the complete run body. Keyed by the
# workflow, the job that must contain it, and the step name, so moving a pinned
# step - into another job, into a job that never runs, or out of the workflow -
# fails, and adding `if: false` to the job it left fails with it.
STEP_PINS = {
    ('.github/workflows/ci.yml', 'release-security-gates', 'Verify release/security invariants'): (
        '      - name: Verify release/security invariants',
        '        env:',
        '          GH_TOKEN: ${{ github.token }}',
        '          GITHUB_TOKEN: ${{ github.token }}',
        '          PR_BASE_REF: ${{ github.event.pull_request.base.ref }}',
        '          PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
        '        run: |',
        '          bash scripts/verify-branch-release-supply-chain.sh',
        '          bash scripts/verify-release-branch-signatures.sh',
        '          bash scripts/verify-release-train-promotion.sh --self-test',
        '          bash scripts/verify-ci-rubric-enforced.sh',
        '          bash scripts/verify-release-workflows.sh',
        '          bash scripts/verify-release-cycle.sh',
    ),
    ('.github/workflows/ci.yml', 'release-security-gates', 'Verify apptheory-init template/release pairing'): (
        '      - name: Verify apptheory-init template/release pairing',
        '        run: |',
        '          bash scripts/verify-release-pairing.sh --self-test',
        '          bash scripts/verify-release-pairing.sh',
    ),
    ('.github/workflows/prerelease-pr.yml', 'release-please', 'Verify apptheory-init template/release pairing'): (
        '      - name: Verify apptheory-init template/release pairing',
        "        if: steps.release_pr.outputs.exists == 'true'",
        '        run: |',
        '          bash scripts/verify-release-pairing.sh --self-test',
        '          bash scripts/verify-release-pairing.sh',
    ),
    ('.github/workflows/release-pr.yml', 'release-please', 'Verify apptheory-init template/release pairing'): (
        '      - name: Verify apptheory-init template/release pairing',
        "        if: steps.release_pr.outputs.exists == 'true'",
        '        run: |',
        '          bash scripts/verify-release-pairing.sh --self-test',
        '          bash scripts/verify-release-pairing.sh',
    ),
    ('.github/workflows/prerelease.yml', 'release-please', 'Verify release workflow invariants (release preflight)'): (
        '      - name: Verify release workflow invariants (release preflight)',
        '        run: bash scripts/verify-release-workflows.sh',
    ),
    ('.github/workflows/release.yml', 'release-please', 'Verify release workflow invariants (stable release preflight)'): (
        '      - name: Verify release workflow invariants (stable release preflight)',
        "        if: github.ref == 'refs/heads/main' && inputs.tag_name == ''",
        '        run: bash scripts/verify-release-workflows.sh',
    ),
}

# Whole-file digests for every shell invoker that can reach the gate or the
# guard. Round 4 pinned three of these by digest and the fourth - the GovTheory
# verifier - by invocation line only, because its own self-test table carries a
# `set +e` / `set -e` capture pair in an unrelated function that the classifier
# had to keep tolerating. There is no tolerance to preserve any more, so all
# four are pinned whole: a `set +e`, a shadowing definition, an added function
# body or a `source` on another line is a finding with nothing parsed.
INVOKER_FILE_DIGESTS = {
    'scripts/verify-release-branch.sh': "5707f8ab5af9a0585119cb6691827b2961056897a92537e27763ac2d5c20fd6f",
    'scripts/verify-release-publish-postcondition.sh': "61b21485d0d97cc06b7c3d62a762fbd79632af78b12cf5e98b8adad6b2ff8766",
    'scripts/verify-release-gates.sh': "ed9bfef8eee60a76437c1e51f9f405644cf6302088431aeb232a96a8450afe18",
    'gov-infra/verifiers/gov-verify-rubric.sh': "5c375a12d5008f671f954c983b03732095b48abd4b5f42f67937e82786f1ea3f",
}

# The transitive closure of the GovTheory verifier's toolchain PATH export:
# every name the export reads, and every name those statements read in turn.
# Round 4 pinned the export's own text and the eight names below it, and left
# `GOV_INFRA` - which `GOV_TOOLS_DIR` reads - free: appending one assignment
# redirected the whole toolchain, so `bash` on PATH was another program while
# the pinned statements were byte-identical. The closure starts at `SCRIPT_DIR`
# now and includes it, so no name in the chain can be re-pointed from any line.
GOV_TOOLCHAIN_ASSIGNMENT_PINS = (
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"',
    'GOV_INFRA="${REPO_ROOT}/gov-infra"',
    'GOV_TOOLS_DIR="${GOV_INFRA}/.tools"',
    'GOV_TOOLS_BIN="${GOV_TOOLS_DIR}/bin"',
    'GOV_TOOLS_PY_DIR="${GOV_TOOLS_DIR}/py"',
    'GOV_TOOLS_PY_BIN="${GOV_TOOLS_PY_DIR}/bin"',
    'GOV_TOOLS_PY_COV_DIR="${GOV_TOOLS_DIR}/py-coverage"',
    'GOV_TOOLS_PY_COV_BIN="${GOV_TOOLS_PY_COV_DIR}/bin"',
    'GOV_TOOLS_PY_RUNTIME_DIR="${GOV_TOOLS_DIR}/py-runtime"',
    'GOV_TOOLS_PY_RUNTIME_BIN="${GOV_TOOLS_PY_RUNTIME_DIR}/bin"',
    'export PATH="${GOV_TOOLS_BIN}:${GOV_TOOLS_PY_BIN}:${GOV_TOOLS_PY_RUNTIME_BIN}:${PATH}"',
)
GOV_TOOLCHAIN_VARIABLES = (
    "SCRIPT_DIR",
    "REPO_ROOT",
    "GOV_INFRA",
    "GOV_TOOLS_DIR",
    "GOV_TOOLS_BIN",
    "GOV_TOOLS_PY_DIR",
    "GOV_TOOLS_PY_BIN",
    "GOV_TOOLS_PY_COV_DIR",
    "GOV_TOOLS_PY_COV_BIN",
    "GOV_TOOLS_PY_RUNTIME_DIR",
    "GOV_TOOLS_PY_RUNTIME_BIN",
    "PATH",
)

# The stripped lines a guarded script may be named on outside a pinned region:
# the invocation lines of the pinned steps themselves. Derived from the pins, so
# the two cannot drift.
PINNED_INVOCATION_LINES = (
    'bash scripts/verify-release-pairing.sh',
    'bash scripts/verify-release-pairing.sh --self-test',
    'bash scripts/verify-release-workflows.sh',
    'run: bash scripts/verify-release-workflows.sh',
)

# Finding classes. Each case in the battery names the class it must fail on, so a
# case that starts failing for an unrelated reason is a battery failure rather
# than a quiet pass.
CLASS_PREAMBLE = "preamble"
CLASS_JOB = "job"
CLASS_JOB_KEY = "job-key"
CLASS_STEP_BYTES = "step-bytes"
CLASS_STEP_JOB = "step-job"
CLASS_DIGEST = "digest"
CLASS_SWEEP = "sweep"
CLASS_TOOLCHAIN = "toolchain"


def normalize_text(text: str) -> str:
    """CRLF to LF, and trailing whitespace off every line. That is the tolerance.

    Nothing else normalises: an editor that writes CRLF, or a formatter that
    leaves trailing spaces, must not trip the guard, and every other byte is
    compared as it stands.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip() for line in text.split("\n"))


def region_lines(text: str) -> tuple:
    lines = normalize_text(text).split("\n")
    while lines and lines[-1] == "":
        lines.pop()
    return tuple(lines)


JOB_BLOCK = r"(?ms)^  {job}:[ \t]*\n(?P<block>.*?)(?=^  [A-Za-z0-9_-]+:[ \t]*\n|\Z)"
STEP_MARKER = re.compile(r"(?m)^      -[ \t]")
JOB_BOUNDARY = re.compile(r"\n  [A-Za-z0-9_-]+:[ \t]*\n")


def job_span(text: str, job: str):
    match = re.search(JOB_BLOCK.format(job=re.escape(job)), text)
    if match is None:
        return None
    return match.start(), match.end()


def step_spans(text: str):
    """(start, end) for every step block, bounded by the next step or the next job.

    The block is the unit a pin compares, not the `run:` body: YAML reads a key
    written after the run body as the same step key as one written before it, so
    a pin that stopped at the last body line would admit `if: false` appended to
    the step. A block that grows or shrinks is then simply not the pinned text.
    """
    starts = [match.start() for match in STEP_MARKER.finditer(text)]
    spans = []
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else len(text)
        boundary = JOB_BOUNDARY.search(text, start)
        if boundary is not None:
            end = min(end, boundary.start())
        spans.append((start, end))
    return spans


def matching_step_spans(text: str):
    """(start, end, lines) for every step block whose exact text is a pinned step."""
    pinned = {tuple(lines) for lines in STEP_PINS.values()}
    matches = []
    for start, end in step_spans(text):
        lines = region_lines(text[start:end])
        if lines in pinned:
            matches.append((start, end, lines))
    return matches


ROOT_KEY = re.compile(r"^(?P<key>[A-Za-z_][A-Za-z0-9_-]*)[ \t]*:")


def root_key_findings(read_text):
    """Findings for a key declared more than once at the workflow's own level.

    The preamble pin fixes the bytes above the first `jobs:` line, so a second
    `jobs:` or `on:` written below it is outside every pin - and YAML keeps the
    last value for a repeated key, so the runner would resolve the one the guard
    never read.
    """
    findings = []
    for path in WORKFLOW_PREAMBLE_PINS:
        counts = {}
        for line in normalize_text(read_text(path)).split("\n"):
            match = ROOT_KEY.match(line)
            if match is not None:
                key = match.group("key")
                counts[key] = counts.get(key, 0) + 1
        for key, count in sorted(counts.items()):
            if count != 1:
                findings.append(
                    (
                        CLASS_PREAMBLE,
                        f"{path}: the workflow-level key {key!r} is declared {count} times; YAML keeps "
                        f"the last value and the runner resolves that one, so a repeated root key is "
                        f"refused rather than read past",
                    )
                )
    return findings


def preamble_findings(read_text):
    findings = []
    for path, pinned in WORKFLOW_PREAMBLE_PINS.items():
        text = normalize_text(read_text(path))
        match = re.search(r"(?m)^jobs:[ \t]*$", text)
        if match is None:
            findings.append(
                (
                    CLASS_PREAMBLE,
                    f"{path}: has no `jobs:` mapping, so the configuration above it cannot be pinned",
                )
            )
            continue
        actual = region_lines(text[: match.start()])
        if actual != pinned:
            findings.append(
                (
                    CLASS_PREAMBLE,
                    f"{path}: the workflow-level configuration above `jobs:` is not the pinned revision; "
                    f"`on:`, `permissions:`, `env:`, `defaults:` and every other workflow-level key is "
                    f"resolved before the pinned step runs, so the region may only change together with "
                    f"the pin that describes it (expected {len(pinned)} pinned line(s), found {len(actual)})",
                )
            )
    return findings


def job_findings(read_text):
    """Findings for a guarded job whose block is not the pinned revision.

    The whole job is pinned, not only the guarded step inside it. Steps share a
    workspace, so a sibling step that runs first can rewrite the guarded script
    and leave the pinned step's own bytes - and both of its invocations - exactly
    as pinned; `printf '' > scripts/verify-release-pa*` in another step of the
    same job makes the pinned invocations exit 0 without touching them. A job
    pin closes that, and closes the job's `if:` with it: the condition is pinned
    present with exactly these bytes, or pinned absent.
    """
    findings = []
    for (path, job), pinned in JOB_PINS.items():
        text = normalize_text(read_text(path))
        key_line = f"  {job}:"
        occurrences = sum(1 for line in text.split("\n") if line == key_line)
        if occurrences != 1:
            findings.append(
                (
                    CLASS_JOB_KEY,
                    f"{path}: the job key `{key_line}` is defined {occurrences} times; YAML keeps the "
                    f"last definition and the runner resolves that one, so the pinned job may be defined "
                    f"exactly once",
                )
            )
        span = job_span(text, job)
        if span is None:
            findings.append((CLASS_JOB, f"{path}: missing job {job!r}"))
            continue
        actual = region_lines(text[span[0] : span[1]])
        if actual != pinned:
            findings.append(
                (
                    CLASS_JOB,
                    f"{path}: job {job!r} is not the pinned revision; the job's `if:` - present with "
                    f"exactly these bytes, or absent - every job-level key, and every step of the job, "
                    f"run in the context the pinned release gate is keyed on, so the block is pinned whole "
                    f"(expected {len(pinned)} pinned line(s), found {len(actual)})",
                )
            )
    return findings


def step_findings(read_text):
    findings = []
    for (path, job, step_name), pinned in STEP_PINS.items():
        text = normalize_text(read_text(path))
        matches = [match for match in matching_step_spans(text) if match[2] == pinned]
        if len(matches) != 1:
            findings.append(
                (
                    CLASS_STEP_BYTES,
                    f"{path}: the pinned step {step_name!r} is not the pinned revision; the guarded step "
                    f"is pinned whole - its name, every key and its complete run body - and its block may "
                    f"appear byte for byte exactly once (expected {len(pinned)} pinned line(s), matched "
                    f"{len(matches)} step block(s))",
                )
            )
            continue
        start, _end, _lines = matches[0]
        span = job_span(text, job)
        if span is None or not (span[0] <= start < span[1]):
            findings.append(
                (
                    CLASS_STEP_JOB,
                    f"{path}: the pinned step {step_name!r} is not inside the pinned job {job!r}; moving a "
                    f"pinned step to another job - or into a job that never runs - leaves its own lines "
                    f"byte-identical while the pinned release context stops running the gate",
                )
            )
    return findings


def digest_findings(read_text):
    findings = []
    for path, pinned in INVOKER_FILE_DIGESTS.items():
        actual = hashlib.sha256(normalize_text(read_text(path)).encode("utf-8")).hexdigest()
        if actual != pinned:
            findings.append(
                (
                    CLASS_DIGEST,
                    f"{path}: is not the pinned revision; this file holds a guarded invocation and may "
                    f"only change together with the pin that describes it (pinned sha256 {pinned[:12]}, "
                    f"found {actual[:12]})",
                )
            )
    return findings


ASSIGNMENT_KEY = re.compile(r"^(?:export[ \t]+)?(?P<key>[A-Za-z_][A-Za-z0-9_]*)=")


def toolchain_findings(read_text):
    findings = []
    text = normalize_text(read_text(GOV_VERIFIER))
    counts = {statement: 0 for statement in GOV_TOOLCHAIN_ASSIGNMENT_PINS}
    for line_number, line in enumerate(text.split("\n"), 1):
        match = ASSIGNMENT_KEY.match(line)
        if match is None or match.group("key") not in GOV_TOOLCHAIN_VARIABLES:
            continue
        if line in counts:
            counts[line] += 1
            continue
        findings.append(
            (
                CLASS_TOOLCHAIN,
                f"{GOV_VERIFIER}:{line_number}: assigns {match.group('key')}, a name in the transitive "
                f"closure of the pinned toolchain PATH export, outside the pinned statements ({line!r}); "
                f"pinning an export's text pins its spelling, not the value it reads",
            )
        )
    for statement, count in counts.items():
        if count != 1:
            findings.append(
                (
                    CLASS_TOOLCHAIN,
                    f"{GOV_VERIFIER}: the pinned toolchain statement {statement!r} appears {count} times; "
                    f"the toolchain a guarded invocation runs under is pinned exactly once",
                )
            )
    return findings


def pinned_line_numbers(read_text):
    """Line indexes covered by a pinned step block, per workflow."""
    covered = {}
    for (path, _job, _step_name), pinned in STEP_PINS.items():
        text = normalize_text(read_text(path))
        for start, _end, lines in matching_step_spans(text):
            if lines != pinned:
                continue
            first_line = text.count("\n", 0, start)
            covered.setdefault(path, set()).update(range(first_line, first_line + len(pinned)))
    return covered


def sweep_findings(read_text, paths=None):
    """Every occurrence of a guarded script name that no byte-exact pin covers.

    A name is admitted from three places and nowhere else: inside a
    digest-pinned invoker, inside a pinned step, or on a line that is
    byte-identical to a pinned invocation line. The third is additive
    strengthening - running a pinned gate from somewhere else cannot make the
    pinned step stop running - and it is admitted outside the five guarded
    workflows only. Inside one, the guarded script may be named on the pinned
    step and nowhere else, because that workflow is the artifact the required
    release context is keyed on.
    """
    findings = []
    covered = pinned_line_numbers(read_text)
    for path in (sweep_paths() if paths is None else paths):
        if path in INVOKER_FILE_DIGESTS:
            continue
        text = normalize_text(read_text(path))
        for index, line in enumerate(text.split("\n")):
            if not any(name in line for name in GUARDED_BASENAMES):
                continue
            if index in covered.get(path, ()):
                continue
            if line.strip() in PINNED_INVOCATION_LINES and path not in GUARDED_WORKFLOWS:
                continue
            findings.append(
                (
                    CLASS_SWEEP,
                    f"{path}:{index + 1}: names a guarded script outside every byte-exact pin "
                    f"({line.strip()!r}); a guarded script name may appear only inside a pinned region, "
                    f"or on a line byte-identical to a pinned invocation line in a location no pin reaches",
                )
            )
    return findings


def guarded_surface_findings(read_text):
    return (
        preamble_findings(read_text)
        + root_key_findings(read_text)
        + job_findings(read_text)
        + step_findings(read_text)
        + digest_findings(read_text)
        + toolchain_findings(read_text)
        + sweep_findings(read_text)
    )
CI_STEP_HEADER = '      - name: Verify apptheory-init template/release pairing\n'
CI_BARE = '          bash scripts/verify-release-pairing.sh\n'
CI_SELF_TEST = '          bash scripts/verify-release-pairing.sh --self-test\n'
CI_STEP_RUN = '      - name: Verify apptheory-init template/release pairing\n        run: |\n'
CI_STEP = '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n'
CI_JOB = '  release-security-gates:\n    name: Release/security gates\n'
CI_HEAD = 'name: CI\n\non:\n'
CI_GUARD_BARE = '          bash scripts/verify-release-workflows.sh\n'
PREMAIN_GUARD_RUN = '        run: bash scripts/verify-release-workflows.sh\n'
GATES_BARE = 'bash ./scripts/verify-release-pairing.sh\n'

# Every weakening shape rounds 1-4 closed, verbatim. Under byte-exact pins most of them
# now fail on a pin rather than on a classifier, so each one names the pin class it must
# fail on: a case that starts failing for an unrelated reason fails the battery too.
ROUND_4_ATTACKS = (
    ('`!` prefix negation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          ! bash scripts/verify-release-pairing.sh\n',
     CLASS_STEP_BYTES,
    ),
    ('`|| echo advisory`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || echo advisory\n',
     CLASS_STEP_BYTES,
    ),
    ('`if false; then ... fi` wrap', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          if false; then\n            bash scripts/verify-release-pairing.sh\n          fi\n',
     CLASS_STEP_BYTES,
    ),
    ('commented-out invocation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          # bash scripts/verify-release-pairing.sh\n',
     CLASS_STEP_BYTES,
    ),
    ('step-level `if: false`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        if: false\n        run: |\n',
     CLASS_STEP_BYTES,
    ),
    ('step-level `if: ${{ false }}`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        if: ${{ false }}\n        run: |\n',
     CLASS_STEP_BYTES,
    ),
    ('step-level `if: always()`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        if: always()\n        run: |\n',
     CLASS_STEP_BYTES,
    ),
    ('job-level `if: false`', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    if: false\n    name: Release/security gates\n',
     CLASS_JOB,
    ),
    ('`|| true`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || true\n',
     CLASS_STEP_BYTES,
    ),
    ('`|| :`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || :\n',
     CLASS_STEP_BYTES,
    ),
    ('`||:`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh ||:\n',
     CLASS_STEP_BYTES,
    ),
    ('`&& true`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh && true\n',
     CLASS_STEP_BYTES,
    ),
    ('`|| exit 0`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || exit 0\n',
     CLASS_STEP_BYTES,
    ),
    ('`; true`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh; true\n',
     CLASS_STEP_BYTES,
    ),
    ('usage-exit flag `--help`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh --help\n',
     CLASS_STEP_BYTES,
    ),
    ('usage-exit flag `-h`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh -h\n',
     CLASS_STEP_BYTES,
    ),
    ('step-level continue-on-error', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        continue-on-error: true\n        run: |\n',
     CLASS_STEP_BYTES,
    ),
    ('job-level continue-on-error', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    continue-on-error: true\n    name: Release/security gates\n',
     CLASS_JOB,
    ),
    ('backslash continuation hiding `|| true`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh \\\n            || true\n',
     CLASS_STEP_BYTES,
    ),
    ('`--self-test`-only step', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n',
     CLASS_STEP_BYTES,
    ),
    ('step-level `shell: bash {0}`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        shell: bash {0}\n        run: |\n',
     CLASS_STEP_BYTES,
    ),
    ('workflow-level `defaults: run: shell: bash {0}`', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\ndefaults:\n  run:\n    shell: bash {0}\n\non:\n',
     CLASS_PREAMBLE,
    ),
    ('env indirection via `BASH_ENV`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        env:\n          BASH_ENV: ./weaken.sh\n        run: |\n',
     CLASS_STEP_BYTES,
    ),
    ('flow-style `env: {BASH_ENV: ...}`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        env: {BASH_ENV: ./weaken.sh}\n        run: |\n',
     CLASS_STEP_BYTES,
    ),
    ('job-level `env: BASH_ENV`', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    env:\n      BASH_ENV: ./weaken.sh\n    name: Release/security gates\n',
     CLASS_JOB,
    ),
    ('backgrounded invocation (`&`)', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh &\n',
     CLASS_STEP_BYTES,
    ),
    ('duplicate `run:` key in the step', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh\n        run: bash scripts/verify-release-pairing.sh || true\n',
     CLASS_STEP_BYTES,
    ),
    ('duplicate `if:` key on the release PR step', '.github/workflows/release-pr.yml',
     "        if: steps.release_pr.outputs.exists == 'true'\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n",
     "        if: steps.release_pr.outputs.exists == 'true'\n        if: false\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n",
     CLASS_STEP_BYTES,
    ),
    ('folded `run: >-` hiding `|| true`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: >-\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh || true\n',
     CLASS_STEP_BYTES,
    ),
    ('heredoc-smuggled invocation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          cat <<EOF\n          bash scripts/verify-release-pairing.sh\n          EOF\n',
     CLASS_STEP_BYTES,
    ),
    ('shell invoker: backgrounded invocation (`&`)', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}" &\n',
     CLASS_DIGEST,
    ),
    ('quoted script path', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-pairing.sh\n',
     'bash "./scripts/verify-release-pairing.sh"\n',
     CLASS_DIGEST,
    ),
    ('variable indirection', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          PAIR="scripts/verify-release-pairing.sh"\n          bash "${PAIR}"\n',
     CLASS_STEP_BYTES,
    ),
    ('release PR step-level `if: false`', '.github/workflows/release-pr.yml',
     "        if: steps.release_pr.outputs.exists == 'true'\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n",
     '        if: false\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n',
     CLASS_STEP_BYTES,
    ),
    ('shell invoker: commented-out invocation', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     '# scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: `if false; then ... fi` wrap', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'if false; then\n  scripts/verify-release-pairing.sh --tag "${expected_tag}"\nfi\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: errexit disabled with `set +e`', 'scripts/verify-release-branch.sh',
     '# The apptheory-init templates substitute',
     'set +e\n# The apptheory-init templates substitute',
     CLASS_DIGEST,
    ),
    ('shell invoker: errexit never set', 'scripts/verify-release-branch.sh',
     'set -euo pipefail\n',
     'set -uo pipefail\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: `bash` shadowed by a function', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-pairing.sh\n',
     'bash ./scripts/verify-release-pairing.sh\nbash() { return 0; }\n',
     CLASS_DIGEST,
    ),
    ('step-level `if: false` written after the run body', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        if: false\n',
     CLASS_STEP_BYTES,
    ),
    ('step-level `continue-on-error: true` written after the run body', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        continue-on-error: true\n',
     CLASS_STEP_BYTES,
    ),
    ('step-level `shell: bash {0}` written after the run body', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        shell: bash {0}\n',
     CLASS_STEP_BYTES,
    ),
    ('step-level `env: BASH_ENV` written after the run body', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        env:\n          BASH_ENV: ./weaken.sh\n',
     CLASS_STEP_BYTES,
    ),
    ('meta-guard step `if: false` written after the run body', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-workflows.sh\n',
     '          bash scripts/verify-release-workflows.sh\n        if: false\n',
     CLASS_STEP_BYTES,
    ),
    ('step body shadows `bash` with a function', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash() { return 0; }\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_STEP_BYTES,
    ),
    ('step body shadows `exit` with a function', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          exit() { :; }\n          bash scripts/verify-release-pairing.sh || exit 1\n',
     CLASS_STEP_BYTES,
    ),
    ('step body reassigns PATH', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          PATH=/tmp/evil:$PATH\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_STEP_BYTES,
    ),
    ('PATH prefix on the invocation line', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          PATH=/tmp/evil:$PATH bash scripts/verify-release-pairing.sh\n',
     CLASS_STEP_BYTES,
    ),
    ('step body clears errexit with `set +e` and a trailing success', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          set +e\n          bash scripts/verify-release-pairing.sh\n          true\n',
     CLASS_STEP_BYTES,
    ),
    ('step body installs a trap that overrides the exit status', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     "          trap 'exit 0' ERR\n          bash scripts/verify-release-pairing.sh\n",
     CLASS_STEP_BYTES,
    ),
    ('step body reassigns BASH_ENV', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          export BASH_ENV=./weaken.sh\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_STEP_BYTES,
    ),
    ('meta-guard step body shadows `bash`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-workflows.sh\n',
     '          bash() { return 0; }\n          bash scripts/verify-release-workflows.sh\n',
     CLASS_STEP_BYTES,
    ),
    ('shell invoker: function shadows `bash` before the invocation', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-pairing.sh\n',
     'bash() { return 0; }\nbash ./scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: `exit() { :; }` with a tolerated fail-closed tail', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'exit() { :; }\nscripts/verify-release-pairing.sh --tag "${expected_tag}" || exit 1\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: PATH prefix on the invocation line', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'PATH=/tmp/evil:$PATH scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: PATH reassignment before the invocation', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'PATH=/tmp/evil:$PATH\nscripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     CLASS_DIGEST,
    ),
    ('`${{ }}` expression as an argument', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh ${{ env.WEAKEN }}\n',
     CLASS_STEP_BYTES,
    ),
    ('variable-indirected `--help` argument', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          PAIRING_ARGS=--help\n          bash scripts/verify-release-pairing.sh "${PAIRING_ARGS}"\n',
     CLASS_STEP_BYTES,
    ),
    ('variable-indirected `--self-test` argument in a release PR workflow', '.github/workflows/release-pr.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          PAIRING_ARGS=--self-test\n          bash scripts/verify-release-pairing.sh "${PAIRING_ARGS}"\n',
     CLASS_STEP_BYTES,
    ),
    ('shell invoker: variable-indirected argument', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-pairing.sh\n',
     'scripts/verify-release-pairing.sh "${PAIRING_ARGS}"\n',
     CLASS_DIGEST,
    ),
    ('tolerated tail backgrounded with `&`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || exit 1 &\n',
     CLASS_STEP_BYTES,
    ),
    ('statement after the tolerated tail', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || exit 1; true\n',
     CLASS_STEP_BYTES,
    ),
    ('tolerated tail piped into a command', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || exit 1 | tee log\n',
     CLASS_STEP_BYTES,
    ),
    ('shell invoker: tolerated tail backgrounded with `&`', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}" || return 1 &\n',
     CLASS_DIGEST,
    ),
    ('meta-guard call with `|| true` in CI', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-workflows.sh\n',
     '          bash scripts/verify-release-workflows.sh || true\n',
     CLASS_STEP_BYTES,
    ),
    ('meta-guard call with `|| true` in the full release gates', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-workflows.sh\n',
     'bash ./scripts/verify-release-workflows.sh || true\n',
     CLASS_DIGEST,
    ),
    ('meta-guard call backgrounded in the full release gates', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-workflows.sh\n',
     'bash ./scripts/verify-release-workflows.sh &\n',
     CLASS_DIGEST,
    ),
    ('meta-guard self-test arm negated in the full release gates', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-workflows.sh --self-test\n',
     '! bash ./scripts/verify-release-workflows.sh --self-test\n',
     CLASS_DIGEST,
    ),
    ('meta-guard call with `|| true` in the prerelease preflight', '.github/workflows/prerelease.yml',
     '        run: bash scripts/verify-release-workflows.sh\n',
     '        run: bash scripts/verify-release-workflows.sh || true\n',
     CLASS_STEP_BYTES,
    ),
    ('meta-guard step conditional changed in the stable preflight', '.github/workflows/release.yml',
     "        if: github.ref == 'refs/heads/main' && inputs.tag_name == ''\n        run: bash scripts/verify-release-workflows.sh\n",
     '        if: false\n        run: bash scripts/verify-release-workflows.sh\n',
     CLASS_STEP_BYTES,
    ),
    ('YAML merge key in a guarded workflow', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\n<<: *defaults\n\non:\n',
     CLASS_PREAMBLE,
    ),
    ('unpinned new step invoking the meta-guard with `|| true`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n',
     '      - name: Unpinned extra gate\n        run: |\n          bash scripts/verify-release-workflows.sh || true\n      - name: Verify apptheory-init template/release pairing\n',
     CLASS_SWEEP,
    ),
    ('unpinned new step invoking the pairing gate with `|| true`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n',
     '      - name: Unpinned pairing gate\n        run: |\n          bash scripts/verify-release-pairing.sh || true\n      - name: Verify apptheory-init template/release pairing\n',
     CLASS_SWEEP,
    ),
    ('unpinned new step carrying a conditional', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n',
     '      - name: Unpinned conditional gate\n        if: always()\n        run: |\n          bash scripts/verify-release-workflows.sh\n      - name: Verify apptheory-init template/release pairing\n',
     CLASS_SWEEP,
    ),
    ('step-level `if : false` (pre-colon whitespace) after the run body', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        if : false\n',
     CLASS_STEP_BYTES,
    ),
    ('job-level `if : false` (pre-colon whitespace)', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    if : false\n    name: Release/security gates\n',
     CLASS_JOB,
    ),
    ('step-level `continue-on-error : true` (pre-colon whitespace)', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        continue-on-error : true\n',
     CLASS_STEP_BYTES,
    ),
    ('step-level `shell : bash {0}` (pre-colon whitespace)', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        shell : bash {0}\n',
     CLASS_STEP_BYTES,
    ),
    ('step-level duplicate `run :` key (pre-colon whitespace)', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh\n        run : bash scripts/verify-release-pairing.sh || true\n',
     CLASS_STEP_BYTES,
    ),
    ('step-level `env :` with `PATH:` (pre-colon whitespace)', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        env :\n          PATH: /tmp/evil\n        run: |\n',
     CLASS_STEP_BYTES,
    ),
    ('step-level non-canonical key the guard does not enumerate', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        timeout-minutes : 5\n',
     CLASS_STEP_BYTES,
    ),
    ('step-level quoted key `"if": false`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        "if": false\n',
     CLASS_STEP_BYTES,
    ),
    ("step-level quoted key `'if' : false`", '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     "      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        'if' : false\n",
     CLASS_STEP_BYTES,
    ),
    ('step-level explicit key `? if`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        ? if\n        : false\n',
     CLASS_STEP_BYTES,
    ),
    ('ANSI-C quoting hiding a `PATH` reassignment', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     "          echo $'it\\'s ok'\n          PATH=/tmp/evil:$PATH\n          echo 'a' 'b'\n          bash scripts/verify-release-pairing.sh\n",
     CLASS_STEP_BYTES,
    ),
    ('ANSI-C quoting hiding a weakened invocation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     "          echo $'it\\'s ok'\n          bash scripts/verify-release-pairing.sh || true\n          echo it is ok\n          bash scripts/verify-release-pairing.sh\n",
     CLASS_STEP_BYTES,
    ),
    ('invocation inside a function called from an `if` condition', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          gate() {\n          bash scripts/verify-release-pairing.sh\n          }\n          if gate; then\n            :\n          fi\n',
     CLASS_STEP_BYTES,
    ),
    ('invocation inside a function that is never called', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          gate() {\n          bash scripts/verify-release-pairing.sh\n          }\n',
     CLASS_STEP_BYTES,
    ),
    ('invocation inside a negated function call', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          gate() {\n          bash scripts/verify-release-pairing.sh\n          }\n          ! gate\n',
     CLASS_STEP_BYTES,
    ),
    ('invocation inside a function in a guarded shell invoker', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'gate() {\n  scripts/verify-release-pairing.sh --tag "${expected_tag}"\n}\nif gate; then\n  :\nfi\n',
     CLASS_DIGEST,
    ),
    ('pinned publisher host called with `|| true`', 'scripts/verify-release-publish-postcondition.sh',
     'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || exit 1\n',
     'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || true\n',
     CLASS_DIGEST,
    ),
    ('pinned publisher host called inside a command substitution', 'scripts/verify-release-publish-postcondition.sh',
     'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || exit 1\n',
     'x="$(verify_release_pairing_postcondition "${tag_name:-${expected_tag}}")"\n',
     CLASS_DIGEST,
    ),
    ('pinned publisher host called plainly inside a wrapper function', 'scripts/verify-release-publish-postcondition.sh',
     'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || exit 1\n',
     'A() {\n  verify_release_pairing_postcondition "${tag_name:-${expected_tag}}"\n}\nif A; then\n  :\nfi\n',
     CLASS_DIGEST,
    ),
    ('pinned publisher host with `|| return 1` inside a wrapper function', 'scripts/verify-release-publish-postcondition.sh',
     'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || exit 1\n',
     'A() {\n  verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || return 1\n}\nA\n',
     CLASS_DIGEST,
    ),
    ('pinned indirect dispatch with a trailing `|| true`', 'gov-infra/verifiers/gov-verify-rubric.sh',
     'run_check "CMP-4" "Compliance" "$CMD_RELEASE_LIFECYCLE"\n',
     'run_check "CMP-4" "Compliance" "$CMD_RELEASE_LIFECYCLE" || true\n',
     CLASS_DIGEST,
    ),
    ('pinned indirect dispatch removed', 'gov-infra/verifiers/gov-verify-rubric.sh',
     'run_check "CMP-4" "Compliance" "$CMD_RELEASE_LIFECYCLE"\n',
     '',
     CLASS_DIGEST,
    ),
    ('pinned dispatch function stops re-enabling errexit', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '    set -euo pipefail\n    eval "${cmd}"\n',
     '    eval "${cmd}"\n',
     CLASS_DIGEST,
    ),
    ('pinned dispatch function softens its errexit setup', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '    set -euo pipefail\n    eval "${cmd}"\n',
     '    set -e\n    eval "${cmd}"\n',
     CLASS_DIGEST,
    ),
    ('step-level `env: PATH`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        env:\n          PATH: /tmp/evil\n        run: |\n',
     CLASS_STEP_BYTES,
    ),
    ('job-level `env: PATH`', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    env:\n      PATH: /tmp/evil\n    name: Release/security gates\n',
     CLASS_JOB,
    ),
    ('workflow-level `env: CDPATH`', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\nenv:\n  CDPATH: /tmp/evil\n\non:\n',
     CLASS_PREAMBLE,
    ),
    ('step-level `env: BASHOPTS`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        env:\n          BASHOPTS: expand_aliases\n        run: |\n',
     CLASS_STEP_BYTES,
    ),
    ('step-level `env: PATH` written as a flow mapping', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        env: {PATH: /tmp/evil}\n        run: |\n',
     CLASS_STEP_BYTES,
    ),
    ('gov verifier: `bash` shadowed in the checked function', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  bash() { return 0; }\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: stray `PATH` reassignment in the checked function', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  export PATH="/tmp/evil:${PATH}"\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: extra trap in the checked function', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  trap \'exit 0\' EXIT\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: errexit cleared in the checked function', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  set +e\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: the pinned toolchain export renamed', 'gov-infra/verifiers/gov-verify-rubric.sh',
     'export PATH="${GOV_TOOLS_BIN}:${GOV_TOOLS_PY_BIN}:${GOV_TOOLS_PY_RUNTIME_BIN}:${PATH}"\n',
     'export PATH="${GOV_TOOLS_BIN}:${PATH}"\n',
     CLASS_DIGEST,
    ),
    ('flow-style step mapping invoking the pairing gate', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n      - {name: Extra gate, run: "bash scripts/verify-release-pairing.sh || true"}\n',
     CLASS_SWEEP,
    ),
    ('flow-style step mapping invoking the meta-guard', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n',
     '      - {name: Extra guard, run: "bash scripts/verify-release-workflows.sh || true"}\n      - name: Verify apptheory-init template/release pairing\n',
     CLASS_SWEEP,
    ),
    ('second YAML document in a guarded workflow', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\n\non:\n---\njobs: {}\n',
     CLASS_PREAMBLE,
    ),
    ('YAML alias as a step run body', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n      - name: Extra anchored gate\n        run: &weak "bash scripts/verify-release-pairing.sh || true"\n      - name: Extra aliased gate\n        run: *weak\n',
     CLASS_SWEEP,
    ),
    ('invocation inside a parens-less `function` body in a step', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          function gate {\n          bash scripts/verify-release-pairing.sh\n          }\n          if gate; then\n            :\n          fi\n',
     CLASS_STEP_BYTES,
    ),
    ('invocation inside a subshell function body', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          gate() (\n          bash scripts/verify-release-pairing.sh\n          )\n          if gate; then\n            :\n          fi\n',
     CLASS_STEP_BYTES,
    ),
    ('invocation inside a conditional function body', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          gate() if true; then\n          bash scripts/verify-release-pairing.sh\n          fi\n',
     CLASS_STEP_BYTES,
    ),
    ('invocation inside a brace-poisoned parens-less function body', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          gate() { echo }\n          function evil {\n          bash scripts/verify-release-pairing.sh\n          }\n          if evil; then\n            :\n          fi\n',
     CLASS_STEP_BYTES,
    ),
    ('invocation inside a parens-less `function` body in the gov verifier', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  function gate {\n  bash ./scripts/verify-release-workflows.sh\n  }\n  if gate; then\n    :\n  fi\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a parens-less `function` body in a shell invoker', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'function gate {\nscripts/verify-release-pairing.sh --tag "${expected_tag}"\n}\nif gate; then\n  :\nfi\n',
     CLASS_DIGEST,
    ),
    ('`bash` shadowed by a parens-less `function` definition in a step', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          function bash { return 0; }\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_STEP_BYTES,
    ),
    ('`bash` shadowed by a parens-less `function` definition in the gov verifier', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  function bash { return 0; }\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('`bash` shadowed by a parens-less `function` definition in a shell invoker', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'function bash { return 0; }\nscripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     CLASS_DIGEST,
    ),
    ('backquote substitution hiding `set +e`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          x="`echo "it\'s"`"\n          set +e\n          echo "it\'s fine"\n          bash scripts/verify-release-pairing.sh\n          true\n',
     CLASS_STEP_BYTES,
    ),
    ('backquote substitution hiding a `PATH` reassignment in the gov verifier', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  x="`echo "it\'s"`"\n  export PATH="/tmp/evil:${PATH}"\n  echo "it\'s fine"\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('workflow-level quoted key `"env":`', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\n"env":\n  PATH: /tmp/evil\n\non:\n',
     CLASS_PREAMBLE,
    ),
    ('workflow-level quoted key `"defaults":`', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\n"defaults":\n  run:\n    shell: bash -c \'exit 0\' {0}\n\non:\n',
     CLASS_PREAMBLE,
    ),
    ('step keys written after extra list-item space', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n',
     '      -   {name: Fake gate, run: "bash scripts/verify-release-pairing.sh || true"}\n      - name: Verify apptheory-init template/release pairing\n',
     CLASS_SWEEP,
    ),
    ('unnamed step written after extra list-item space', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n',
     '      -   run: |\n          bash scripts/verify-release-pairing.sh || true\n      - name: Verify apptheory-init template/release pairing\n',
     CLASS_SWEEP,
    ),
    ("gov verifier: the pinned toolchain export's input redirected", 'gov-infra/verifiers/gov-verify-rubric.sh',
     'mkdir -p "${GOV_TOOLS_BIN}"\n',
     'GOV_TOOLS_BIN="/tmp/evil:${GOV_TOOLS_BIN}"\nmkdir -p "${GOV_TOOLS_BIN}"\n',
     CLASS_TOOLCHAIN,
    ),
    ('unpinned step key added to a pinned step', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        working-directory: /tmp/evil\n',
     CLASS_STEP_BYTES,
    ),
    ('second line naming the meta-guard in the gov verifier', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n  bash ./scripts/verify-release-workflows.sh --self-test\n',
     CLASS_DIGEST,
    ),
    ("step body sources a file into the invocation's shell", '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          source /tmp/evil.sh\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_STEP_BYTES,
    ),
    ("step body dot-sources a file into the invocation's shell", '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          . /tmp/evil.sh\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_STEP_BYTES,
    ),
    ("step body evaluates text into the invocation's shell", '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          eval "$(cat /tmp/evil.sh)"\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_STEP_BYTES,
    ),
    ('step body moves the shell before the invocation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          cd /tmp/evil\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_STEP_BYTES,
    ),
    ('gov verifier: the checked function sources a file', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  source /tmp/evil.sh\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: the checked function moves the shell', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  cd /tmp/evil\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('workflow-level `defaults.run.working-directory`', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\ndefaults:\n  run:\n    working-directory: /tmp/evil\n\non:\n',
     CLASS_PREAMBLE,
    ),
    ('job-level `defaults.run.working-directory`', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    defaults:\n      run:\n        working-directory: /tmp/evil\n    name: Release/security gates\n',
     CLASS_JOB,
    ),
    ('step-level `working-directory`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        working-directory: /tmp/evil\n',
     CLASS_STEP_BYTES,
    ),
    ('workflow-level `defaults.run.shell` in a meta-guard workflow', '.github/workflows/release.yml',
     'name: Release (main)\n',
     "name: Release (main)\ndefaults:\n  run:\n    shell: bash -c 'exit 0' {0}\n",
     CLASS_PREAMBLE,
    ),
    ('exported shell function shadow via `BASH_FUNC_`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     "          export BASH_FUNC_bash%%='() { return 0; }'\n          bash scripts/verify-release-pairing.sh\n",
     CLASS_STEP_BYTES,
    ),
    ('`hash -p` re-pins the command name', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          hash -p /tmp/evil/bash bash\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_STEP_BYTES,
    ),
    ('duplicate job name carrying `if: false`', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    name: Release/security gates\n  release-security-gates:\n    name: Decoy\n    if: false\n',
     CLASS_JOB_KEY,
    ),
    ('second workflow-level `defaults:` with a poisoned shell', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     "name: CI\ndefaults:\n  run:\n    shell: bash\n\ndefaults:\n  run:\n    shell: bash -c 'exit 0' {0}\n\non:\n",
     CLASS_PREAMBLE,
    ),
)

# Constants the battery anchors on.

# The discarded accepted table, re-evaluated under the collapse. Each of these was admitted
# by round 4's freedom to add a statement or an inert section; each changes the bytes of a
# pinned region or names a guarded script outside one. All six now fail. The intended
# workflow for any of them is to update the pin in the same PR - a documented two-place edit.
ROUND_4_ACCEPTED_RECYCLED = (
    ('trailing comment after the invocation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh # pinned in the release doc\n',
     CLASS_STEP_BYTES,
    ),
    ('next-line `true` after the invocation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh\n          true\n',
     CLASS_STEP_BYTES,
    ),
    ('quoted pinned `--self-test` argument', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh --self-test\n',
     '          bash scripts/verify-release-pairing.sh "--self-test"\n',
     CLASS_STEP_BYTES,
    ),
    ('set +e / set -e capture pair in an unrelated gov verifier function', 'gov-infra/verifiers/gov-verify-rubric.sh',
     'check_file_budgets() {\n',
     'check_file_budgets() {\n  set +e\n  :\n  set -e\n',
     CLASS_DIGEST,
    ),
    ('YAML anchor defined in an inert `x-` section', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\nx-bodies:\n  weak: &weak "bash scripts/verify-release-pairing.sh || true"\n\non:\n',
     CLASS_SWEEP,
    ),
    ('unrelated verifier added to a pinned release/security step', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-workflows.sh\n',
     '          bash scripts/verify-api-snapshots.sh\n          bash scripts/verify-release-workflows.sh\n',
     CLASS_STEP_BYTES,
    ),
)


# ---------------------------------------------------------------------------
# Round 5: the collapse. Every case below is a repro of a finding from the
# adversarial review of round 4 (head 0c85ad5d), re-run against byte-exact pins,
# plus the pin-policy cases the new construction is claimed to have.
# ---------------------------------------------------------------------------

META_GUARD_BODY_FIRST = "          bash scripts/verify-branch-release-supply-chain.sh\n"

ROUND_5_ATTACKS = (
    # F1 - round 4 admitted an own-line extra statement it judged inert. `exit 0`
    # as the first line of a run body is inert in no sense: the pinned statements
    # below it stay byte-identical and never run.
    ("F1 own-line `exit 0` first in the pairing step", ".github/workflows/ci.yml",
     CI_STEP_RUN, CI_STEP_RUN + "          exit 0\n", CLASS_STEP_BYTES),
    ("F1 own-line `exec true` first in the pairing step", ".github/workflows/ci.yml",
     CI_STEP_RUN, CI_STEP_RUN + "          exec true\n", CLASS_STEP_BYTES),
    ("F1 own-line `exit 0` first in the release/security step", ".github/workflows/ci.yml",
     META_GUARD_BODY_FIRST, "          exit 0\n" + META_GUARD_BODY_FIRST, CLASS_STEP_BYTES),
    ("F1 own-line `exit 0` first in the prerelease preflight", ".github/workflows/prerelease.yml",
     PREMAIN_GUARD_RUN,
     "        run: |\n          exit 0\n          bash scripts/verify-release-workflows.sh\n",
     CLASS_STEP_BYTES),
    ("F1 own-line `exec true` first in the stable preflight", ".github/workflows/release.yml",
     PREMAIN_GUARD_RUN,
     "        run: |\n          exec true\n          bash scripts/verify-release-workflows.sh\n",
     CLASS_STEP_BYTES),
    # F2 - the heredoc mask ran on comment-split code without the quoting walker,
    # so a quoted `<<` opened a mask that hid the lines below it.
    ("F2 quoted `<<` opens a mask over a shadowed `bash` and a redirected PATH", ".github/workflows/ci.yml",
     CI_BARE,
     '          echo "docs say << true marker"\n'
     "          bash() { return 0; }\n"
     "          PATH=/tmp/evil:$PATH\n"
     "          true\n" + CI_BARE,
     CLASS_STEP_BYTES),
    ("F2 quoted `<<` opens a mask in the release/security step", ".github/workflows/ci.yml",
     META_GUARD_BODY_FIRST,
     '          echo "docs say << true marker"\n'
     "          bash() { return 0; }\n"
     "          true\n" + META_GUARD_BODY_FIRST,
     CLASS_STEP_BYTES),
    # F3 - the closure of the pinned toolchain export was incomplete: GOV_INFRA
    # was read by a pinned statement and never pinned itself, and REPO_ROOT and
    # SCRIPT_DIR were pinned by nothing at all.
    ("F3 `GOV_INFRA` redirected above the pinned toolchain", GOV_VERIFIER,
     'mkdir -p "${GOV_TOOLS_BIN}"\n',
     'GOV_INFRA="/tmp/evilgov"\nmkdir -p "${GOV_TOOLS_BIN}"\n',
     CLASS_TOOLCHAIN),
    ("F3 `REPO_ROOT` re-pointed so the exempted `source` lines load elsewhere", GOV_VERIFIER,
     'PLANNING_DIR="${GOV_INFRA}/planning"\n',
     'REPO_ROOT="/tmp/evilrepo"\nPLANNING_DIR="${GOV_INFRA}/planning"\n',
     CLASS_TOOLCHAIN),
    ("F3 `SCRIPT_DIR` re-pointed at the head of the closure", GOV_VERIFIER,
     'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n',
     'SCRIPT_DIR="/tmp/evil"\n',
     CLASS_TOOLCHAIN),
    # F4 - pins keyed by (workflow, step name) only, so the pinned step could be
    # moved verbatim into a job that never runs.
    ("F4 pinned ci.yml pairing step moved verbatim into an `if: false` job", ".github/workflows/ci.yml",
     CI_STEP,
     "  quarantined-pairing:\n"
     "    name: Quarantined pairing\n"
     "    if: false\n"
     "    runs-on: ubuntu-latest\n"
     "    steps:\n" + CI_STEP,
     CLASS_STEP_JOB),
    ("F4 `if: false` added to the pinned ci.yml pairing job", ".github/workflows/ci.yml",
     CI_JOB,
     "  release-security-gates:\n    if: false\n    name: Release/security gates\n",
     CLASS_JOB),
    # F5 - the same admitted-freedom rule as F1: an extra statement that names no
    # guarded basename was admitted as inert, and a glob truncate leaves the
    # pinned invocations byte-identical while they run an empty file.
    ("F5 glob truncate of the paired gate before the pinned invocations", ".github/workflows/ci.yml",
     CI_BARE,
     "          printf '' > scripts/verify-release-pa*\n" + CI_BARE,
     CLASS_STEP_BYTES),
    # Round 5's own pin policy.
    ("a new step in a guarded workflow on an unpinned invocation line", ".github/workflows/ci.yml",
     CI_STEP_HEADER,
     "      - name: Extra pairing arm\n        run: |\n"
     "          bash scripts/verify-release-pairing.sh --published\n" + CI_STEP_HEADER,
     CLASS_SWEEP),
    ("a call site added to the Makefile on an unpinned line", "Makefile",
     "test: test-unit\n",
     "bash scripts/verify-release-workflows.sh --self-test\ntest: test-unit\n",
     CLASS_SWEEP),
    ("a workflow-level key added above `jobs:`", ".github/workflows/ci.yml",
     CI_HEAD,
     "name: CI\nenv:\n  FOO: bar\n\non:\n",
     CLASS_PREAMBLE),
    ("a second root-level `jobs:` mapping added below the first", ".github/workflows/ci.yml",
     "      - name: Run full rubric\n        run: make rubric\n",
     "      - name: Run full rubric\n        run: make rubric\n"
     "jobs:\n  decoy:\n    name: Release/security gates\n    runs-on: ubuntu-latest\n    steps: []\n",
     CLASS_PREAMBLE),
    ("a job-level key added to a pinned job", ".github/workflows/prerelease.yml",
     "  release-please:\n    runs-on: ubuntu-latest\n",
     "  release-please:\n    timeout-minutes: 1\n    runs-on: ubuntu-latest\n",
     CLASS_JOB),
    ("a sibling step added to a pinned job", ".github/workflows/ci.yml",
     META_GUARD_BODY_FIRST,
     "      - name: Extra unguarded helper\n"
     "        run: bash scripts/verify-api-snapshots.sh\n" + CI_GUARD_BARE + META_GUARD_BODY_FIRST,
     CLASS_JOB),
    ("the pinned job key defined a second time", ".github/workflows/prerelease.yml",
     "  release-please:\n    runs-on: ubuntu-latest\n",
     "  release-please:\n    if: false\n    runs-on: ubuntu-latest\n  release-please:\n",
     CLASS_JOB_KEY),
)

SELF_TEST_ATTACKS = ROUND_4_ATTACKS + ROUND_4_ACCEPTED_RECYCLED + ROUND_5_ATTACKS


# The shapes that must stay accepted, so a pin that starts over-blocking fails
# the self-test as loudly as a pin that starts missing. Two of them are the
# disclosure: `scripts/verify-ci-rubric-enforced.sh` and this guard itself are
# pinned by nothing in this repository, and the battery asserts that boundary
# rather than leaving it claimed in prose only.
SELF_TEST_ACCEPTED = (
    (
        "trailing whitespace on a pinned step line",
        ".github/workflows/ci.yml",
        lambda text: text.replace(CI_SELF_TEST, CI_SELF_TEST.rstrip("\n") + "   \n", 1),
    ),
    (
        "trailing whitespace on a digest-pinned invoker line",
        "scripts/verify-release-gates.sh",
        lambda text: text.replace(GATES_BARE, GATES_BARE.rstrip("\n") + "   \n", 1),
    ),
    (
        "CRLF line endings in a guarded workflow",
        ".github/workflows/ci.yml",
        lambda text: text.replace("\n", "\r\n"),
    ),
    (
        "a byte-identical pinned invocation line added to the Makefile",
        "Makefile",
        lambda text: text.replace(
            "test: test-unit\n",
            "bash scripts/verify-release-workflows.sh\ntest: test-unit\n",
            1,
        ),
    ),
    (
        "a job-level key added to an unrelated job in a guarded workflow",
        ".github/workflows/ci.yml",
        lambda text: text.replace(
            "  cdk-go-drift:\n    name: CDK Go binding drift\n",
            "  cdk-go-drift:\n    name: CDK Go binding drift\n    timeout-minutes: 30\n",
            1,
        ),
    ),
    (
        "the disclosed boundary: verify-ci-rubric-enforced.sh is not read",
        "scripts/verify-ci-rubric-enforced.sh",
        lambda text: text.replace(
            'require_contains "${ci}" "bash scripts/verify-release-workflows.sh" \\\n',
            'require_contains "${ci}" "bash scripts/verify-branch-release-supply-chain.sh" \\\n',
            1,
        ),
    ),
    (
        "the disclosed boundary: the paired gate's own file is not read by the guard",
        "scripts/verify-release-pairing.sh",
        lambda text: text.replace(
            "set -euo pipefail\n", "set -euo pipefail\necho tampered\n", 1
        ),
    ),
    (
        "the disclosed boundary: the guard's own file is not read by the guard",
        "scripts/verify-release-workflows.sh",
        lambda text: text.replace("GUARDED_BASENAMES = ", "GUARDED_BASENAMES = ()  # tampered\n", 1),
    ),
)


def fixture_paths():
    paths = set(sweep_paths())
    paths.update(INVOKER_FILE_DIGESTS)
    paths.update(WORKFLOW_PREAMBLE_PINS)
    paths.add(GOV_VERIFIER)
    paths.add("scripts/verify-ci-rubric-enforced.sh")
    paths.add("scripts/verify-release-workflows.sh")
    paths.add("scripts/verify-release-pairing.sh")
    return tuple(sorted(paths))


def run_self_test() -> None:
    fixture = {path: Path(path).read_text(encoding="utf-8") for path in fixture_paths()}

    def read_from(source):
        def read_text(path):
            if path not in source:
                raise SystemExit(
                    f"release-workflows: FAIL (self-test read {path!r} outside the fixture set)"
                )
            return source[path]

        return read_text

    baseline = guarded_surface_findings(read_from(fixture))
    if baseline:
        raise SystemExit(
            "release-workflows: FAIL (self-test: the legitimate guarded wiring was REJECTED, so the "
            "guard over-blocks: " + "; ".join(message for _kind, message in baseline)
        )
    print("release-workflows: PASS-PROOF (self-test accepted: the legitimate guarded wiring at HEAD)")

    for label, path, anchor, replacement, expected in SELF_TEST_ATTACKS:
        source = dict(fixture)
        if anchor not in source[path]:
            raise SystemExit(
                f"release-workflows: FAIL (self-test fixture drifted: the {label!r} anchor is missing "
                f"from {path})"
            )
        source[path] = source[path].replace(anchor, replacement, 1)
        findings = guarded_surface_findings(read_from(source))
        if not findings:
            raise SystemExit(
                f"release-workflows: FAIL (self-test MISSED the {label!r} weakening in {path})"
            )
        kinds = {kind for kind, _message in findings}
        if expected not in kinds:
            joined = " | ".join(f"{kind}: {message}" for kind, message in findings)
            raise SystemExit(
                f"release-workflows: FAIL (self-test caught the {label!r} weakening but reported an "
                f"unexpected diagnostic; expected {expected!r} in {joined!r})"
            )
        print(f"release-workflows: FAIL-PROOF (self-test rejected: {label} in {path} -> {expected})")

    for label, path, mutate in SELF_TEST_ACCEPTED:
        source = dict(fixture)
        mutated = mutate(source[path])
        if mutated == source[path]:
            raise SystemExit(
                f"release-workflows: FAIL (self-test fixture drifted: the {label!r} mutation changed "
                f"nothing in {path})"
            )
        source[path] = mutated
        findings = guarded_surface_findings(read_from(source))
        if findings:
            raise SystemExit(
                f"release-workflows: FAIL (self-test OVER-BLOCKS the accepted shape {label!r} in "
                f"{path}: " + "; ".join(message for _kind, message in findings)
            )
        print(f"release-workflows: ACCEPT-PROOF (self-test accepted: {label} in {path})")

    print(
        f"release-workflows: PASS (self-test: {len(SELF_TEST_ATTACKS)} weakening shape(s) failed closed, "
        f"{len(SELF_TEST_ACCEPTED)} fail-closed spelling(s) accepted, the legitimate wiring accepted)"
    )


if MODE == "self-test":
    run_self_test()
    raise SystemExit(0)

# The runbook states these two counts in prose. Reflowed line breaks are normal in
# Markdown and are not drift, so the document is compared with its whitespace
# collapsed; the numbers themselves are read out of the battery, never restated.
_doc_claim = (
    f"{len(SELF_TEST_ATTACKS)} weakening shapes fail closed and "
    f"{len(SELF_TEST_ACCEPTED)} fail-closed spellings are accepted"
)
if _doc_claim not in " ".join(Path("docs/release-process.md").read_text(encoding="utf-8").split()):
    raise SystemExit(
        "release-workflows: FAIL (docs/release-process.md must state the counts this battery actually "
        f"reports, so the documented claim cannot drift from the cases behind it; missing "
        f"{_doc_claim!r})"
    )

guarded_surface = guarded_surface_findings(lambda path: Path(path).read_text(encoding="utf-8"))
if guarded_surface:
    raise SystemExit(
        "release-workflows: FAIL (a guarded release-gate region is not its pinned revision; "
        + "; ".join(message for _kind, message in guarded_surface) + ")"
    )
require_order(
    ".github/workflows/prerelease.yml",
    "Verify branch version sync (release preflight)",
    "Release Please (Prerelease)",
    "prerelease creation must fail closed on stale branch release state before release-please can publish",
)
require_order(
    ".github/workflows/release.yml",
    "Verify branch version sync (stable release preflight)",
    "Release Please (Stable)",
    "stable release creation must fail closed on stale branch release state before release-please can publish",
)
require_order(
    ".github/workflows/prerelease.yml",
    "Release Please (Prerelease)",
    "Verify prerelease publish postcondition",
    "prerelease publisher must validate release-please outputs before asset publishing",
)
require_order(
    ".github/workflows/release.yml",
    "Release Please (Stable)",
    "Verify stable publish postcondition",
    "stable publisher must validate release-please outputs before asset publishing",
)
for workflow in (".github/workflows/prerelease.yml", ".github/workflows/release.yml"):
    require_contains(
        workflow,
        "concurrency:\n  group: release-publisher-${{ github.repository }}\n  cancel-in-progress: false",
        "release publisher workflows must share one non-cancelling concurrency group",
    )
    require_not_contains(
        workflow,
        "cancel-in-progress: true",
        "release publisher workflows must queue reruns and workflow_dispatch events instead of cancelling an active publisher",
    )
    require_order(
        workflow,
        "workflow_dispatch",
        "concurrency:",
        "release publisher concurrency must apply at workflow scope, including workflow_dispatch reruns",
    )
    require_order(
        workflow,
        "concurrency:",
        "permissions:",
        "release publisher concurrency must be declared before jobs so the whole publisher workflow is serialized",
    )
release_pr_concurrency = {
    ".github/workflows/prerelease-pr.yml": (
        "concurrency:\n"
        "  group: release-pr-${{ github.repository }}-release-please--branches--premain\n"
        "  cancel-in-progress: false"
    ),
    ".github/workflows/release-pr.yml": (
        "concurrency:\n"
        "  group: release-pr-${{ github.repository }}-release-please--branches--main\n"
        "  cancel-in-progress: false"
    ),
}
for workflow, snippet in release_pr_concurrency.items():
    require_contains(
        workflow,
        snippet,
        "generated release PR workflows must serialize per release PR without cancelling an active sync",
    )
    require_not_contains(
        workflow,
        "cancel-in-progress: true",
        "generated release PR workflows must queue overlapping runs instead of cancelling an active sync",
    )
    require_order(
        workflow,
        "workflow_dispatch",
        "concurrency:",
        "generated release PR concurrency must apply at workflow scope, including workflow_dispatch reruns",
    )
    require_order(
        workflow,
        "concurrency:",
        "jobs:",
        "generated release PR concurrency must be declared before jobs so PR sync is serialized",
    )
release_please_draft_guard = (
    "if: github.event_name != 'pull_request' || github.event.pull_request.draft == false || "
    "(github.event.pull_request.head.ref != 'release-please--branches--premain' && "
    "github.event.pull_request.head.ref != 'release-please--branches--main')"
)
for job in ("version-alignment", "go", "ts", "py", "contract-tests"):
    require_job_contains(
        ".github/workflows/ci.yml",
        job,
        release_please_draft_guard,
        "required CI checks must not evaluate draft release-please heads before generated artifacts are synced",
    )
require_not_contains(
    ".github/workflows/release.yml",
    "if: github.ref == 'refs/heads/main'\n",
    "workflow_dispatch existing-tag uploads must not run stable main preflight from branch HEAD",
)
require_contains(
    ".github/workflows/release.yml",
    "if: github.ref == 'refs/heads/main' && inputs.tag_name == ''",
    "stable release branch preflight must be skipped for workflow_dispatch existing-tag uploads",
)
require_not_contains(
    ".github/workflows/release.yml",
    "ref: ${{ steps.release.outputs.tag_name }}",
    "stable release asset build must not assume release-please draft releases have materialized git tags",
)
for workflow in (".github/workflows/prerelease.yml", ".github/workflows/release.yml"):
    require_contains(
        workflow,
        'scripts/publish-release-assets.sh "${TAG_NAME}"',
        "release workflows must publish assets through the shared draft-release-safe path",
    )
    require_not_contains(
        workflow,
        "make rubric",
        "release publisher workflows must use release hygiene and publish postconditions instead of the full rubric",
    )
require_contains(
    ".github/workflows/prerelease.yml",
    "scripts/verify-release-publish-postcondition.sh prerelease",
    "prerelease publisher must fail closed when a generated RC release PR merge does not create an RC release",
)
require_contains(
    ".github/workflows/release.yml",
    "scripts/verify-release-publish-postcondition.sh stable",
    "stable publisher must fail closed when a generated stable release PR merge does not create a stable release",
)
require_contains(
    ".github/workflows/prerelease.yml",
    "Recover or verify existing prerelease",
    "prerelease reruns must recover drafts and verify already-published immutable releases",
)
require_contains(
    ".github/workflows/release.yml",
    "Recover or verify existing stable release",
    "stable reruns must recover drafts and verify already-published immutable releases",
)
for workflow, channel, closure_step in (
    (".github/workflows/prerelease.yml", "prerelease", "Verify prerelease publication closure"),
    (".github/workflows/release.yml", "stable", "Verify stable publication closure"),
):
    require_not_contains(
        workflow,
        "--json isDraft",
        "release reruns must verify already-published releases instead of skipping non-drafts",
    )
    require_contains(
        workflow,
        f'scripts/verify-release-publish-postcondition.sh {channel} "${{RELEASE_CREATED}}" "${{TAG_NAME}}" prepublish',
        "release workflows must validate Release Please output before the publisher mutates tag state",
    )
    require_contains(
        workflow,
        f'scripts/verify-release-publish-postcondition.sh {channel} "${{RELEASE_CREATED}}" "${{TAG_NAME}}" complete',
        "release workflows must prove Go module publication closure after the publisher",
    )
    require_order(
        workflow,
        "prepublish",
        closure_step,
        "release workflows must run the prepublish gate before the complete publication postcondition",
    )
    require_order(
        workflow,
        'scripts/publish-release-assets.sh "${TAG_NAME}"',
        closure_step,
        "release workflows must finish the serialized publisher before the complete postcondition",
    )
for workflow in (".github/workflows/prerelease.yml", ".github/workflows/release.yml"):
    require_contains(
        workflow,
        "scripts/diagnose-release-state.sh --tag",
        "failed release publisher jobs must print read-only release diagnostics",
    )
require_contains(
    ".github/workflows/release.yml",
    "- name: Diagnose failed release state (read-only)\n        if: failure()",
    "stable diagnostics must run for main, tag, and workflow_dispatch publisher failures",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "release-diagnostics: branch=",
    "release diagnostics must print the current branch and head",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "release-diagnostics: tag=",
    "release diagnostics must print the active tag state",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "go-module-tag=",
    "release diagnostics must report nested Go module tag state",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "cut a new version",
    "release diagnostics must refuse repair by moving a conflicting immutable module tag",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "release-diagnostics: release=",
    "release diagnostics must print GitHub Release state",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "release-diagnostics: manifests:",
    "release diagnostics must print manifest state",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "release-diagnostics: safe-next-action=",
    "release diagnostics must print the safe next action",
)
for forbidden in (
    "gh release upload",
    "gh release edit",
    "gh release create",
    "gh release delete",
    "gh release delete-asset",
):
    require_not_contains(
        "scripts/diagnose-release-state.sh",
        forbidden,
        "release diagnostics must not mutate GitHub Releases",
    )
require_contains(
    "scripts/publish-release-assets.sh",
    'git fetch "${remote}" "${main_branch}" "${premain_branch}" --tags --force',
    "release asset publisher must fetch branch and tag refs before provenance checks",
)
require_order(
    "scripts/publish-release-assets.sh",
    'scripts/verify-release-branch.sh "${tag}"',
    "scripts/verify-version-alignment.sh",
    "release asset publisher must verify the resolved source before version/package checks",
)
require_order(
    "scripts/publish-release-assets.sh",
    "scripts/verify-version-alignment.sh",
    "make build",
    "release asset publisher must verify version alignment before building release assets",
)
require_not_contains(
    "scripts/publish-release-assets.sh",
    "make rubric",
    "release asset publisher must not run the full rubric",
)
require_order(
    "scripts/publish-release-assets.sh",
    "make build",
    "scripts/generate-checksums.sh",
    "release asset publisher must build dist artifacts before generating checksums",
)
require_order(
    "scripts/publish-release-assets.sh",
    "scripts/generate-checksums.sh",
    'gh release upload "${tag}"',
    "release asset publisher must checksum artifacts before upload",
)
require_order_after(
    "scripts/publish-release-assets.sh",
    "scripts/generate-checksums.sh",
    "collect_release_assets asset_paths",
    "publish_and_verify_go_modules",
    "release asset publisher must finish deterministic source builds before creating module tags",
)
require_order(
    "scripts/publish-release-assets.sh",
    "scripts/publish-go-module-tags.sh",
    "scripts/verify-go-module-tags.sh",
    "release asset publisher must create immutable module tags before exact resolution",
)
require_order_after(
    "scripts/publish-release-assets.sh",
    "collect_release_assets asset_paths",
    "publish_and_verify_go_modules",
    'gh release upload "${tag}"',
    "release asset publisher must prove Go modules before uploading draft assets",
)
require_order_after(
    "scripts/publish-release-assets.sh",
    "collect_release_assets asset_paths",
    "publish_and_verify_go_modules",
    'gh release edit "${tag}" --target "${source_commit}" --draft=false',
    "release asset publisher must prove Go modules before publication becomes visible",
)
for path in (
    "scripts/go-module-release-contract.sh",
    "scripts/publish-go-module-tags.sh",
    "scripts/verify-go-module-tags.sh",
):
    require_contains(
        "scripts/verify-branch-release-supply-chain.sh",
        path,
        f"release supply-chain verifier must require {path}",
    )
for forbidden in (
    "git push --force",
    "git push -f",
    "git tag -f",
    "git push --delete",
):
    require_not_contains(
        "scripts/publish-go-module-tags.sh",
        forbidden,
        "Go module tag publisher must never move or delete an existing tag",
    )
require_contains(
    "scripts/publish-go-module-tags.sh",
    "refs are immutable",
    "Go module tag publisher must fail closed on a conflicting existing ref",
)
require_contains(
    "scripts/publish-go-module-tags.sh",
    "concurrently created",
    "Go module tag publisher must safely accept a same-SHA create race",
)
require_contains(
    "scripts/verify-go-module-tags.sh",
    "GOPROXY=direct",
    "Go module postcondition must bypass stale proxy state and resolve the exact Git refs",
)
require_contains(
    "scripts/verify-go-module-tags.sh",
    'origin.get("Hash")',
    "Go module postcondition must prove the resolved commit hash",
)
require_contains(
    "scripts/verify-go-module-tags.sh",
    'origin.get("Ref")',
    "Go module postcondition must prove the root or nested tag ref",
)
require_contains(
    "scripts/publish-release-assets.sh",
    '--clobber',
    "release asset publisher must replace any existing draft assets during recovery",
)
require_not_contains(
    "scripts/publish-release-assets.sh",
    "is already published; immutable releases prevent adding assets/notes",
    "release asset publisher reruns must verify published immutable assets instead of failing before integrity checks",
)
require_contains(
    "scripts/publish-release-assets.sh",
    "verify_published_release_assets",
    "release asset publisher must verify immutable assets when a rerun finds the release already published",
)
require_contains(
    "scripts/publish-release-assets.sh",
    "published release is missing immutable asset",
    "release asset publisher must fail closed when a published release is missing an expected asset",
)
require_contains(
    "scripts/publish-release-assets.sh",
    "does not match source build",
    "release asset publisher must fail closed when a published release asset checksum differs from the source build",
)
require_contains(
    "scripts/publish-release-assets.sh",
    "already published with matching immutable assets",
    "release asset publisher must skip safely when rerun after successful publication",
)
require_not_contains(
    "scripts/publish-release-assets.sh",
    "release-assets: skip existing",
    "release asset publisher must not trust existing draft assets by filename",
)
require_order(
    "scripts/publish-release-assets.sh",
    "scripts/generate-checksums.sh",
    "collect_release_assets asset_paths",
    "release asset publisher must enumerate source-built assets after checksums are generated",
)
require_order_after(
    "scripts/publish-release-assets.sh",
    "collect_release_assets asset_paths",
    "verify_published_release_assets",
    'gh release upload "${tag}" "${asset_path}" --clobber',
    "release asset publisher must verify-and-skip published releases before any clobbering draft upload",
)
require_order_after(
    "scripts/publish-release-assets.sh",
    'if ! gh release upload "${tag}" "${asset_path}" --clobber; then',
    "verify_published_release_assets",
    "failed to upload draft asset",
    "release asset publisher must re-check immutable publication races before failing an upload rerun",
)
require_order(
    "scripts/publish-release-assets.sh",
    'gh release upload "${tag}"',
    'gh release edit "${tag}" --target "${source_commit}" --draft=false',
    "release asset publisher must upload assets before publishing the immutable release",
)
require_order_after(
    "scripts/publish-release-assets.sh",
    'gh release edit "${tag}" --target "${source_commit}" --draft=false',
    'git fetch "${remote}" tag "${tag}" --force',
    'scripts/verify-release-branch.sh "${tag}"',
    "release asset publisher must verify the materialized tag after publishing",
)
require_contains(
    "scripts/verify-release-branch.sh",
    "ALLOW_UNTAGGED_DRAFT_RELEASE",
    "release branch verifier must only allow missing tag refs for explicitly verified draft releases",
)
require_order(
    "scripts/verify-release-branch.sh",
    'tag_commit="$(git rev-parse "${DRAFT_RELEASE_TARGET}^{commit}")"',
    'if [[ "${commit}" != "${tag_commit}" ]]',
    "release branch verifier must compare HEAD to the tag or draft target commit before allowing asset builds",
)
require_contains(
    "scripts/verify-release-pairing.sh",
    "union ranges are not verified",
    "template/release pairing verifier must fail closed on range syntax it cannot decide",
)
require_contains(
    "scripts/verify-release-pairing.sh",
    "release candidate packed at the wrong version",
    "template/release pairing verifier must reject a CDK tarball packed at a version other than VERSION",
)
require_contains(
    "scripts/verify-release-branch.sh",
    'scripts/verify-release-pairing.sh --tag "${expected_tag}"',
    "release branch verifier must pair apptheory-init templates with the release-candidate CDK tarball before assets are built",
)
require_contains(
    "scripts/verify-release-publish-postcondition.sh",
    "bash scripts/verify-release-pairing.sh --published",
    "publish postcondition verifier must pair the published release CDK asset with the shipped templates",
)
require_order(
    "scripts/verify-release-publish-postcondition.sh",
    'if [[ "${phase}" != "complete" ]]',
    "bash scripts/verify-release-pairing.sh --published",
    "publish postcondition verifier must only pair against the published asset once publication completes",
)
require_contains(
    "scripts/verify-release-publish-postcondition.sh",
    'if [[ "${release_created}" != "true" ]]; then\n    return 0\n  fi\n\n  # Post-publish leg',
    "publish postcondition verifier must pair only the release created by the run, not a republished older release",
)
require_contains(
    "scripts/verify-release-gates.sh",
    "bash ./scripts/verify-release-pairing.sh",
    "full release gates must pair apptheory-init templates with the release-candidate CDK tarball",
)
require_contains(
    ".github/workflows/ci.yml",
    "bash scripts/verify-release-pairing.sh",
    "CI release/security gates must run the template/release pairing verifier",
)
for release_pr_workflow in (".github/workflows/prerelease-pr.yml", ".github/workflows/release-pr.yml"):
    require_contains(
        release_pr_workflow,
        "bash scripts/verify-release-pairing.sh",
        f"{release_pr_workflow} must pair apptheory-init templates with the release-candidate CDK tarball before generated artifact sync",
    )
    require_order(
        release_pr_workflow,
        "Verify apptheory-init template/release pairing",
        "Sync generated CDK artifacts on release PR",
        f"{release_pr_workflow} must fail closed on template/release skew before syncing generated CDK artifacts",
    )
require_contains(
    ".github/workflows/ci.yml",
    "ready_for_review",
    "CI must run when humans mark draft release PRs ready",
)
require_contains(
    ".github/workflows/ci.yml",
    "workflow_dispatch:\n    inputs:\n      run_full_rubric:",
    "CI must be dispatchable for bot-authored release PR branch updates with explicit rubric control",
)
require_contains(
    ".github/workflows/ci.yml",
    "default: true",
    "manual CI workflow_dispatch must continue to run the full rubric by default",
)
require_contains(
    ".github/workflows/ci.yml",
    'release_pr_number:\n        description: "Generated release PR number for head-bound release checks"',
    "generated release CI dispatch must identify the exact release PR",
)
require_contains(
    ".github/workflows/ci.yml",
    "github.event_name == 'workflow_dispatch' && inputs.release_pr_number != ''",
    "release promotion verification must run inside generated release CI dispatches",
)
require_contains(
    ".github/workflows/ci.yml",
    "permissions:\n  contents: read\n  pull-requests: read",
    "head-bound release CI dispatch must have read-only pull request metadata access",
)
require_contains(
    ".github/workflows/ci.yml",
    'if [[ "${PR_HEAD_REF}" != "${DISPATCH_HEAD_REF}" || "${PR_HEAD_SHA}" != "${DISPATCH_HEAD_SHA}" ]]; then',
    "release promotion dispatch must bind the requested PR to the dispatched branch and SHA",
)
require_contains(
    ".github/workflows/ci.yml",
    "if: (github.event_name == 'workflow_dispatch' && (inputs.run_full_rubric == true || inputs.run_full_rubric == 'true')) || (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging')",
    "full rubric must run only on staging PRs and opted-in manual dispatch",
)
require_contains(
    ".github/workflows/ci.yml",
    "name: Verify deterministic builds",
    "CI must keep the standalone deterministic-build job name stable",
)
require_contains(
    ".github/workflows/ci.yml",
    "if: github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging'",
    "deterministic builds must run only on staging PRs",
)
require_contains(
    ".github/workflows/ci.yml",
    "Release train promotion gate",
    "CI must gate release train promotion PRs before release state can advance",
)
require_contains(
    ".github/workflows/ci.yml",
    "scripts/verify-release-train-promotion.sh",
    "CI must run the release train promotion verifier",
)
require_contains(
    ".github/workflows/ci.yml",
    "ref: refs/heads/staging",
    "release train promotion verifier must run from trusted protected release gate code",
)
require_not_contains(
    ".github/workflows/ci.yml",
    "ref: ${{ github.event.pull_request.head.sha }}",
    "release train promotion verifier must not execute verifier code from the untrusted PR head",
)
require_not_contains(
    ".github/workflows/ci.yml",
    "refs/pull/${PR_NUMBER}/head:${pr_head_data_ref}",
    "release train promotion verifier must not fetch untrusted PR head content in CI",
)
require_contains(
    ".github/workflows/ci.yml",
    "GITHUB_TOKEN: ${{ github.token }}",
    "release train promotion verifier must use the read-only workflow token for compare API ancestry checks",
)
require_contains(
    ".github/workflows/ci.yml",
    "base_ref_args=(--base-ref \"refs/remotes/origin/${PR_BASE_REF}\")",
    "release train promotion verifier must use fetched protected base refs instead of PR-head checkout data",
)
require_contains(
    ".github/workflows/ci.yml",
    'release_ref_depth_args=(--unshallow)',
    "release train promotion verifier must unshallow trusted protected release branch history",
)
for branch in ("staging", "premain", "main"):
    require_contains(
        ".github/workflows/ci.yml",
        f"+refs/heads/{branch}:refs/remotes/origin/{branch}",
        f"release train promotion verifier must fetch protected {branch} history for topology checks",
    )
require_contains(
    ".github/workflows/ci.yml",
    '--head-sha "${PR_HEAD_SHA}"',
    "release train promotion verifier must pass the event head SHA without fetching PR head content",
)
require_contains(
    ".github/workflows/ci.yml",
    'pr_title_args=(--pr-title "${PR_TITLE}")',
    "release train promotion verifier must pass PR titles when trusted verifier code supports title checks",
)
require_contains(
    ".github/workflows/ci.yml",
    '--github-repository "${GITHUB_REPOSITORY}"',
    "release train promotion verifier must identify the protected repository for compare checks",
)
require_contains(
    ".github/workflows/ci.yml",
    '--github-head-repository "${PR_HEAD_REPOSITORY}"',
    "release train promotion verifier must compare fork PR heads in their source repository",
)
require_not_contains(
    ".github/workflows/ci.yml",
    "--head-ref HEAD",
    "release train promotion verifier must not trust the checkout HEAD as release PR head content",
)
require_contains(
    ".github/workflows/ci.yml",
    "persist-credentials: false",
    "release train promotion checkout must not persist credentials",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    'ancestor_branch="premain", descendant_branch=head',
    "prerelease promotion verifier must topology-check staging to premain promotions",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "does not match trusted {remote}/{branch}",
    "release train promotion verifier must reject forged release branch head content",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "compare/{ancestor_sha}...{descendant_sha}",
    "release train promotion verifier must use GitHub compare data for untrusted PR head ancestry",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "refs/remotes/origin/pr/1/head",
    "release train promotion self-test must cover fetched PR head data that forges a release branch name",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "staging → premain → main → staging",
    "release train promotion verifier must preserve the single valid branch ordering",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "release-please--branches--premain",
    "release train promotion verifier must allow generated premain RC release-please PRs only on premain",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "release-please--branches--main",
    "release train promotion verifier must allow generated main stable release-please PRs only on main",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "must originate from trusted repository",
    "release train promotion verifier must reject forked generated release-please branch spoofing",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "event head SHA is required to verify generated release-please branch",
    "release train promotion verifier must require exact release-please head SHA provenance",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "does not match trusted origin/release-please--branches--premain",
    "release train promotion self-test must reject forged release-please head SHA",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "main release gate rejects RC-shaped PR titles/versions",
    "main release promotion gate must reject RC-shaped main PR titles/versions",
)
require_contains(
    ".github/workflows/ci.yml",
    "name: Release/security gates",
    "CI must expose release/security gates as a stable non-skipped branch-protection context",
)
require_contains(
    ".github/workflows/ci.yml",
    "bash scripts/verify-release-train-promotion.sh --self-test",
    "CI release/security gates must exercise release train provenance self-tests",
)
require_contains(
    ".github/workflows/ci.yml",
    "bash scripts/verify-ci-rubric-enforced.sh",
    "CI release/security gates must verify rubric enforcement separately from the full rubric",
)
require_contains(
    ".github/workflows/ci.yml",
    "bash scripts/verify-runtime-floor-claims.sh",
    "CI release/security gates must fail closed on unsupported Python/Node floor claims",
)
require_contains(
    "scripts/verify-release-gates.sh",
    "bash ./scripts/verify-release-train-promotion.sh --self-test",
    "full release gates must include release train provenance self-tests",
)
require_contains(
    "scripts/verify-release-gates.sh",
    "bash ./scripts/verify-release-cycle.sh",
    "full release gates must include deterministic full-cycle release regression",
)
require_contains(
    "scripts/verify-release-gates.sh",
    "bash ./scripts/verify-runtime-floor-claims.sh",
    "full release gates must fail closed on unsupported Python/Node floor claims",
)
require_contains(
    "scripts/verify-release-cycle.sh",
    "REQUIRED_COVERAGE",
    "release cycle verifier must declare required coverage cases",
)
for coverage in (
    "happy_path",
    "go_module_tags",
    "publish_recovery_race",
    "stale_release_please_pr",
    "promotion_drift",
    "back_merge_drift",
):
    require_contains(
        "scripts/verify-release-cycle.sh",
        coverage,
        f"release cycle verifier must cover {coverage}",
    )
require_contains(
    ".github/workflows/ci.yml",
    "scripts/verify-branch-version-sync.sh",
    "CI must run the branch release-version sync verifier with git metadata",
)
require_order(
    ".github/workflows/prerelease-pr.yml",
    "Verify branch version sync before release PR",
    "Release Please (PR only)",
    "prerelease PR generation must fail closed before opening stale release-please PRs",
)
for workflow in (".github/workflows/prerelease-pr.yml", ".github/workflows/release-pr.yml"):
    require_contains(
        workflow,
        "scripts/run-release-please-pr.sh",
        "release PR workflows must create release-please PRs through the stale-state-tolerant wrapper",
    )
require_not_contains(
    "scripts/run-release-please-pr.sh",
    'valid release PR already exists',
    "release-please PR generation must not short-circuit before release-please can refresh stale open PRs",
)
require_order(
    "scripts/run-release-please-pr.sh",
    "draft_lock_existing_open_release_pr_before_refresh",
    "bash scripts/invoke-release-please-pr.sh",
    "release-please PR generation may draft-lock already-open PRs but must still invoke release-please",
)
require_order(
    "scripts/run-release-please-pr.sh",
    "bash scripts/invoke-release-please-pr.sh",
    'if use_existing_open_release_pr "release-please exited ${release_please_status} after creating or finding a release PR"; then',
    "release-please PR generation must recover when stale release-please state errors after a valid PR exists",
)
require_not_contains(
    "scripts/run-release-please-pr.sh",
    "--token",
    "release-please credentials must never be forwarded through npm or shell process arguments",
)
require_contains(
    "scripts/run-release-please-pr.sh",
    'gh pr ready "${pr_number}" --undo',
    "release-please PR generation must draft-lock valid open release PRs before artifact setup",
)
for workflow, step_name in (
    (".github/workflows/prerelease-pr.yml", "Release Please (PR only)"),
    (".github/workflows/release-pr.yml", "Release Please (PR only) (aligned)"),
    (".github/workflows/release-pr.yml", "Release Please (PR only)"),
):
    require_step_contains(
        workflow,
        step_name,
        "GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}",
        "release-please wrapper steps must authenticate gh CLI with the release token fallback",
    )
require_order(
    ".github/workflows/prerelease.yml",
    "Verify branch version sync (release preflight)",
    "Verify release workflow invariants (release preflight)",
    "prerelease creation must fail closed on stale branch release state before release workflow checks",
)
require_order(
    ".github/workflows/prerelease.yml",
    "actions/setup-go",
    "Verify release workflow invariants (release preflight)",
    "prerelease workflow checks must use the pinned Go toolchain for module probe self-tests",
)
require_order(
    ".github/workflows/release.yml",
    "actions/setup-go",
    "Verify release workflow invariants (stable release preflight)",
    "stable workflow checks must use the pinned Go toolchain for module probe self-tests",
)
require_contains(
    ".github/workflows/prerelease-pr.yml",
    "scripts/verify-release-pr-postcondition.sh prerelease",
    "prerelease PR generation must fail closed when release-please no-ops",
)
require_contains(
    ".github/workflows/release-pr.yml",
    "scripts/verify-release-pr-postcondition.sh stable",
    "stable Release PR generation must fail closed when release-please no-ops",
)
require_contains(
    "scripts/verify-release-pr-postcondition.sh",
    "parse_version_value",
    "release PR postcondition verifier must parse annotated VERSION values before shape validation",
)
require_contains(
    "scripts/verify-release-pr-postcondition.sh",
    "1.12.2-rc # x-release-please-version",
    "release PR postcondition verifier self-test must cover annotated RC VERSION values",
)
require_contains(
    "docs/release-process.md",
    "watch the first generated",
    "release process runbook must keep an evidence-bounded first-RC watch for release-please extra-files changes",
)
require_contains(
    "docs/release-process.md",
    "CI is not a signing key holder",
    "release process runbook must document the no-CI-signing-secrets policy",
)
require_contains(
    "docs/release-process.md",
    "local_status=N",
    "release process runbook must distinguish local unresolved SSH verification from GitHub verified-valid evidence",
)
for forbidden in (
    "RELEASE_ARTIFACT_SYNC_" + "GPG",
    "RELEASE_ARTIFACT_SYNC_" + "GPG_" + "PRIVATE" + "_KEY",
    "RELEASE_ARTIFACT_SYNC_" + "GPG_KEY_ID",
    "RELEASE_ARTIFACT_SYNC_" + "GPG_PASSPHRASE",
):
    for path in (
        ".github/workflows/prerelease-pr.yml",
        ".github/workflows/release-pr.yml",
        "scripts/render-release-artifact-sync-plan.py",
        "scripts/sync-release-pr-generated.sh",
        "docs/release-process.md",
    ):
        require_not_contains(
            path,
            forbidden,
            "release artifact sync must not depend on CI-held signing secrets",
        )
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "--raw-field run_full_rubric=false",
    "automated release PR CI dispatch must disable the full rubric",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    '--raw-field release_pr_number="${pr_number}"',
    "automated release PR CI dispatch must bind checks to the exact release PR",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "Release train promotion gate\nRelease/security gates",
    "release PR sync must wait for promotion and release/security checks in the single dispatched run",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "Rubric (full gate set)",
    "release PR sync required checks must exclude the full rubric context",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "Verify deterministic builds",
    "release PR sync required checks must exclude skipped deterministic-build contexts",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'gh pr ready "${pr_number}" --undo',
    "release PR sync must force the release PR back to draft before generated artifact work",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "--local-signed-sync",
    "release PR sync must retain an explicit offline local signed artifact sync fallback",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'artifact_sync_commit_message="chore(release): sync generated release artifacts"',
    "release PR sync must use one stable generated artifact sync commit message",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'artifact_sync_commit_body="[skip ci]"',
    "generated artifact commits must suppress redundant pull_request CI events",
)
require_contains(
    "scripts/render-release-artifact-sync-plan.py",
    '"body": args.body',
    "GitHub-created generated artifact commits must carry the automatic-event suppression marker",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    '--body "${artifact_sync_commit_body}"',
    "release PR sync must pass the automatic-event suppression marker into the GitHub commit plan",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'git commit -m "${artifact_sync_commit_message}" -m "${artifact_sync_commit_body}"',
    "local signed release PR sync fallback must use normal local git commit signing configuration",
)
require_contains(
    "scripts/invoke-release-please-pr.mjs",
    '`${options.message}\\n\\n[skip ci]`',
    "release-please commits must suppress redundant pull_request CI events",
)
require_contains(
    "docs/release-process.md",
    "one explicit `workflow_dispatch` CI run",
    "release runbook must document the single-trigger generated release PR contract",
)
require_contains(
    "scripts/render-release-artifact-sync-plan.py",
    "createCommitOnBranch",
    "CI release PR sync must create generated artifact commits through GitHub server-side verified automation",
)
require_contains(
    "scripts/render-release-artifact-sync-plan.py",
    '"--no-renames"',
    "GitHub artifact plans must represent module-root moves as explicit additions and deletions",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "github-verified-api",
    "release PR sync self-test must prove CI selects the GitHub-verified API mode",
)
require_contains(
    "scripts/render-release-artifact-sync-plan.py",
    '"expectedHeadOid": args.expected_head',
    "GitHub API generated artifact sync must use optimistic expectedHeadOid concurrency",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "scripts/render-release-artifact-sync-plan.py",
    "release PR sync must use the shared fail-closed artifact plan renderer",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "gh api graphql --input",
    "CI generated artifact sync must send a GraphQL createCommitOnBranch mutation",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "verify_github_synced_head",
    "CI generated artifact sync must fetch and verify the GitHub-created commit before continuing",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "push_local_signed_release_artifact_sync",
    "release PR sync must isolate git push to the offline local signed fallback",
)
require_order_after(
    "scripts/sync-release-pr-generated.sh",
    'case "${sync_mode}" in',
    "local-signed)",
    "push_local_signed_release_artifact_sync",
    "only the local signed fallback may push a generated artifact commit",
)
require_order_after(
    "scripts/sync-release-pr-generated.sh",
    'case "${sync_mode}" in',
    "github-verified-api)",
    "commit_release_artifact_sync_via_github",
    "CI generated artifact sync must use GitHub API commit creation instead of git push",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'scripts/verify-release-branch-signatures.sh',
    "CI generated artifact sync must prove the new release branch commit is accepted by the signature gate",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    '--range "${expected_head}..${new_head}"',
    "CI generated artifact sync signature proof must scan exactly the created commit range",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    'git commit -S -m "chore(release): sync generated release artifacts"',
    "release PR sync must not force a bespoke CI signing path",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "gpg --import",
    "release PR sync must not import signing material",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "git config user.signingkey",
    "release PR sync must not set signing keys",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "git config gpg.program",
    "release PR sync must not replace the local signing program",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "git config commit.gpgsign true",
    "release PR sync must not mutate commit-signing configuration",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "git verify-commit HEAD",
    "release PR sync must verify generated artifact commit signatures before pushing",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "git log -1 --format=%G?",
    "release PR sync must report and gate the generated commit signature status",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "GitHub Actions must select createCommitOnBranch sync mode",
    "release PR sync self-test must prove CI uses GitHub-verified product automation instead of a manual stop",
)
require_contains(
    ".github/workflows/ci.yml",
    "scripts/verify-release-branch-signatures.sh",
    "release/security gates must scan branch signatures",
)
require_contains(
    "scripts/verify-release-branch-signatures.sh",
    "HISTORICAL_UNSIGNED_FIXTURE",
    "release signature gate must have a historical unsigned negative fixture",
)
require_contains(
    "scripts/verify-release-branch-signatures.sh",
    "github-verified",
    "release signature gate must distinguish GitHub-verified signatures from local signatures",
)
require_contains(
    "scripts/verify-release-branch-signatures.sh",
    "self-test:github-verified-fallback",
    "release signature gate self-test must prove GitHub verified-valid fallback without unsigned commits",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "Keep the PR ready only until the required check contexts exist",
    "release PR sync must not depend on recursive pull_request events from bot-authored PR mutations",
)
for workflow in (".github/workflows/prerelease-pr.yml", ".github/workflows/release-pr.yml"):
    require_contains(
        workflow,
        "actions: write",
        "release PR workflow must be able to dispatch independent CI for bot-authored branch updates",
    )
    require_not_contains(
        workflow,
        "statuses: write",
        "release PR workflow must not be able to self-attest protected release PR gate statuses",
    )
    require_order(
        workflow,
        "actions/setup-python",
        "Sync generated CDK artifacts on release PR",
        "release PR workflow must install Python before running the full release PR gate set",
    )
    require_step_contains(
        workflow,
        "Sync generated CDK artifacts on release PR",
        "GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}",
        "release PR artifact sync step must authenticate gh without signing secrets",
    )
    require_order(
        workflow,
        "Draft-lock release PR before artifact setup",
        "actions/setup-go",
        "release PR workflow must draft-lock release PRs before installing artifact-generation toolchains",
    )
    require_order(
        workflow,
        "Draft-lock release PR before artifact setup",
        "Sync generated CDK artifacts on release PR",
        "release PR workflow must draft-lock release PRs before artifact sync",
    )
require_order(
    "scripts/sync-release-pr-generated.sh",
    'ensure_release_pr_is_draft "before generated artifacts are synced"',
    "scripts/update-cdk-generated.sh",
    "generated artifact sync must draft-lock the release PR before regenerating artifacts",
)
require_order_after(
    "scripts/sync-release-pr-generated.sh",
    'git switch --detach "${expected_head}"',
    "sync_stable_release_premain_manifest",
    "scripts/update-cdk-generated.sh",
    "stable premain manifest reset must happen before regenerating artifacts",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "git add -A",
    "stable release PR sync must commit the premain manifest reset with generated release artifacts",
)
for generated_path in (
    ".release-please-manifest.premain.json",
    "cdk/.jsii",
    "cdk/lib",
    "cdk-go/go.mod",
    "cdk-go/go.sum",
    "cdk-go/apptheorycdk",
):
    require_contains(
        "scripts/sync-release-pr-generated.sh",
        generated_path,
        f"release PR sync must include {generated_path} in the generated artifact transaction",
    )
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "bash scripts/verify-cdk-go.sh",
    "release PR sync must validate generated CDK Go bindings through the nested-module verifier",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "go test ./cdk-go/apptheorycdk",
    "release PR sync must not test the nested cdk-go package from the root Go module",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'synced_head="$(git rev-parse HEAD)"',
    "local signed release PR sync must capture the local signed generated-artifact head",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'synced_head="$(commit_release_artifact_sync_via_github "${expected_head}" "${repo}")"',
    "CI release PR sync must capture the GitHub-created generated-artifact head",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'synced_head="${expected_head}"',
    "release PR sync must preserve the fetched release PR head when generated artifacts are already current",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    'synced_head="$(commit_release_artifact_sync_via_github "${expected_head}" "${repo}")"',
    'verify_github_synced_head "${expected_head}" "${synced_head}" "${repo}"',
    "CI release PR sync must verify the GitHub-created generated-artifact head before waiting for it",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    'verify_github_synced_head "${expected_head}" "${synced_head}" "${repo}"',
    'wait_for_pr_head "${synced_head}"',
    "release PR sync must prove the GitHub-created commit signature before checking independent CI",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    'wait_for_pr_head "${synced_head}"',
    "After the generated-artifact head is visible",
    "release PR sync must wait for the pushed artifact commit before checking independent CI",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    "After the generated-artifact head is visible",
    "dispatch_required_checks\nwait_for_required_checks_to_start\nwait_for_required_checks",
    "release PR sync must dispatch and wait for independent CI after the generated-artifact head is visible",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "check-runs?per_page=100",
    "release PR sync must read commit check-runs because workflow_dispatch checks are not always surfaced by PR checks",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "COMMIT_CHECKS_JSON",
    "release PR sync must merge commit-attached check-runs into the required check view",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "headSha",
    "release PR sync must only pass required checks attached to the current PR head",
)
require_order_after(
    "scripts/sync-release-pr-generated.sh",
    "dispatch_required_checks\nwait_for_required_checks_to_start\nwait_for_required_checks",
    "wait_for_required_checks",
    'require_pr_head "${synced_head}" "after required checks passed"',
    "release PR must re-check the generated-artifact head after required checks pass",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    'require_pr_head "${synced_head}" "after required checks passed"',
    'if ! gh pr ready "${pr_number}"; then',
    "release PR must wait for required checks before becoming ready",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'current_pr_state}" != "OPEN" && "${current_pr_state}" != "MERGED"',
    "release PR sync must keep checking required contexts if an externally merged release PR is already terminal",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "already merged after generated artifacts and required checks matched",
    "release PR sync must treat an externally merged synced PR as a benign terminal state after checks pass",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'gh pr ready "${pr_number}" --undo || true',
    "release PR sync must restore draft state if the PR head changes while becoming ready",
)
for forbidden in (
    "repos/${GITHUB_REPOSITORY}/statuses",
    "set_release_pr_status",
    "run_release_pr_status_check",
    "run_release_pr_required_checks",
):
    require_not_contains(
        "scripts/sync-release-pr-generated.sh",
        forbidden,
        "release PR sync must not self-attest protected contexts",
    )

subprocess.run(["bash", "scripts/verify-branch-version-sync.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/verify-release-pr-postcondition.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/verify-release-publish-postcondition.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/publish-go-module-tags.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/verify-go-module-tags.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/render-release-notes.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/diagnose-release-state.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/sync-release-pr-generated.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/verify-release-please-token-safety.sh"], check=True)

print("release-workflows: PASS")
PY
