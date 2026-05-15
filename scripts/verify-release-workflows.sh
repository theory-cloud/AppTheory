#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

python3 - <<'PY'
from pathlib import Path


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


require_order(
    ".github/workflows/prerelease.yml",
    "Build + verify before prerelease creation",
    "Release Please (Prerelease)",
    "prerelease must pass rubric before release-please can create a draft release",
)
require_order(
    ".github/workflows/release.yml",
    "Build + verify before stable release creation",
    "Release Please (Stable)",
    "stable release must pass rubric before release-please can create a draft release",
)
for workflow in (".github/workflows/prerelease.yml", ".github/workflows/release.yml"):
    require_order(
        workflow,
        "Build + verify\n        if: steps.release.outputs.release_created == 'true'",
        "Build release assets",
        "release workflows must run rubric before building release assets",
    )
    require_order(
        workflow,
        "Build release assets",
        "Generate SHA-256 checksums",
        "release workflows must build dist artifacts before generating checksums",
    )
require_contains(
    ".github/workflows/ci.yml",
    "ready_for_review",
    "CI must run when humans mark draft release PRs ready",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'gh pr ready "${pr_number}" --undo',
    "release PR sync must force the release PR back to draft before generated artifact work",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "Keep the PR ready only until the required check contexts exist",
    "release PR sync must not depend on recursive pull_request events from bot-authored PR mutations",
)
for workflow in (".github/workflows/prerelease-pr.yml", ".github/workflows/release-pr.yml"):
    require_contains(
        workflow,
        "statuses: write",
        "release PR workflow must be allowed to publish protected release PR gate statuses",
    )
    require_order(
        workflow,
        "actions/setup-python",
        "Sync generated CDK artifacts on release PR",
        "release PR workflow must install Python before running the full release PR gate set",
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
require_order(
    "scripts/sync-release-pr-generated.sh",
    'wait_for_pr_head "$(git rev-parse HEAD)"',
    "After the generated-artifact head is visible",
    "release PR sync must wait for the pushed artifact commit before running checks",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    "After the generated-artifact head is visible",
    "run_release_pr_required_checks\nwait_for_required_checks",
    "release PR sync must run checks after the generated-artifact head is visible",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    "set_release_pr_status pending",
    "set_release_pr_status success",
    "release PR sync must publish pending statuses before passing statuses",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    "run_release_pr_status_check \"Version alignment\"",
    "run_release_pr_status_check \"Rubric (full gate set)\"",
    "release PR sync must run the version gate before the full rubric status",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    "run_release_pr_status_check \"Rubric (full gate set)\" \"make rubric\"",
    "wait_for_required_checks_to_start\n  ensure_release_pr_is_draft \"after running generated-artifact checks\"",
    "release PR sync must publish all required statuses before verifying their contexts exist",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    "wait_for_required_checks",
    'gh pr ready "${pr_number}"\n\n',
    "release PR must wait for required checks before becoming ready",
)

print("release-workflows: PASS")
PY
