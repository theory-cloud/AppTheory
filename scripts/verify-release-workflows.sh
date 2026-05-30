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
    "ref: ${{ github.event.pull_request.base.sha }}",
    "release train promotion verifier must run from trusted base branch code",
)
require_not_contains(
    ".github/workflows/ci.yml",
    "ref: ${{ github.event.pull_request.head.sha }}",
    "release train promotion verifier must not execute verifier code from the untrusted PR head",
)
require_contains(
    ".github/workflows/ci.yml",
    "refs/pull/${PR_NUMBER}/head:${pr_head_data_ref}",
    "release train promotion verifier must fetch the PR head only as git data",
)
require_contains(
    ".github/workflows/ci.yml",
    'fetched_head_sha="$(git rev-parse "${pr_head_data_ref}^{commit}")"',
    "release train promotion verifier must confirm fetched PR data matches the event head SHA",
)
require_contains(
    ".github/workflows/ci.yml",
    "--base-ref HEAD",
    "release train promotion verifier must treat the trusted checkout as the base ref",
)
require_contains(
    ".github/workflows/ci.yml",
    '--head-ref "${pr_head_data_ref}"',
    "release train promotion verifier must pass the fetched PR head data ref explicitly",
)
require_contains(
    ".github/workflows/ci.yml",
    "fetch-depth: 0",
    "release train promotion verifier must have enough git history for ancestry checks",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "staging → premain → main → staging",
    "release train promotion verifier must preserve the single valid branch ordering",
)
require_contains(
    "scripts/verify-release-gates.sh",
    "bash ./scripts/verify-release-cycle.sh",
    "full release gates must include deterministic full-cycle release regression",
)
require_contains(
    "scripts/verify-release-cycle.sh",
    "REQUIRED_COVERAGE",
    "release cycle verifier must declare required coverage cases",
)
for coverage in (
    "happy_path",
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
require_order(
    "scripts/run-release-please-pr.sh",
    'if use_existing_open_release_pr "valid release PR already exists"; then',
    'npx "${args[@]}"',
    "release-please PR generation must tolerate already-open draft release PRs before invoking release-please",
)
require_order(
    "scripts/run-release-please-pr.sh",
    'npx "${args[@]}"',
    'if use_existing_open_release_pr "release-please exited ${release_please_status} after creating or finding a release PR"; then',
    "release-please PR generation must recover when stale release-please state errors after a valid PR exists",
)
require_contains(
    "scripts/run-release-please-pr.sh",
    'gh pr ready "${pr_number}" --undo',
    "release-please PR generation must draft-lock valid open release PRs before artifact setup",
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
    'synced_head="$(git rev-parse HEAD)"',
    'wait_for_pr_head "${synced_head}"',
    "release PR sync must capture the generated-artifact head before waiting for it",
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
    'gh pr ready "${pr_number}"\n\n',
    "release PR must wait for required checks before becoming ready",
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

print("release-workflows: PASS")
PY
