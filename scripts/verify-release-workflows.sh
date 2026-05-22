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
require_contains(
    ".github/workflows/prerelease.yml",
    "Recover existing draft prerelease assets",
    "prerelease reruns must recover draft releases left by a failed first attempt",
)
require_contains(
    ".github/workflows/release.yml",
    "Recover existing draft release assets",
    "stable reruns must recover draft releases left by a failed first attempt",
)
require_contains(
    "scripts/publish-release-assets.sh",
    'git fetch "${remote}" "${main_branch}" "${premain_branch}" --tags --force',
    "release asset publisher must fetch branch and tag refs before provenance checks",
)
require_order(
    "scripts/publish-release-assets.sh",
    'scripts/verify-release-branch.sh "${tag}"',
    "make rubric",
    "release asset publisher must verify the resolved source before running rubric",
)
require_order(
    "scripts/publish-release-assets.sh",
    "make rubric",
    "make build",
    "release asset publisher must run rubric before building release assets",
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
require_contains(
    "scripts/publish-release-assets.sh",
    '--clobber',
    "release asset publisher must replace any existing draft assets during recovery",
)
require_not_contains(
    "scripts/publish-release-assets.sh",
    "release-assets: skip existing",
    "release asset publisher must not trust existing draft assets by filename",
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
    ".github/workflows/ci.yml",
    "ready_for_review",
    "CI must run when humans mark draft release PRs ready",
)
require_contains(
    ".github/workflows/ci.yml",
    "workflow_dispatch: {}",
    "CI must be dispatchable for bot-authored release PR branch updates",
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
require_order(
    ".github/workflows/prerelease.yml",
    "Verify branch version sync (release preflight)",
    "Build + verify before prerelease creation",
    "prerelease creation must fail closed on stale branch release state before rubric",
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
    "git switch --detach FETCH_HEAD",
    "sync_stable_release_premain_manifest",
    "scripts/update-cdk-generated.sh",
    "stable premain manifest reset must happen before regenerating artifacts",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "git add .release-please-manifest.premain.json cdk/.jsii cdk/lib cdk-go/apptheorycdk",
    "stable release PR sync must commit the premain manifest reset with generated release artifacts",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    'wait_for_pr_head "$(git rev-parse HEAD)"',
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
require_order(
    "scripts/sync-release-pr-generated.sh",
    "wait_for_required_checks",
    'gh pr ready "${pr_number}"\n\n',
    "release PR must wait for required checks before becoming ready",
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

print("release-workflows: PASS")
PY
