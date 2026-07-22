#!/usr/bin/env bash
# Purpose: verify GitHub release workflows preserve the immutable release contract.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

python3 - <<'PY'
import subprocess
import re
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
            f"release-workflows: FAIL ({description}; missing {needle!r} in {step_name!r} step in {path})"
        )


def require_job_contains(path: str, job_name: str, needle: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    match = re.search(
        rf"(?ms)^  {re.escape(job_name)}:\n(?P<block>.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)",
        text,
    )
    if not match:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing job {job_name!r} in {path})")
    if needle not in match.group("block"):
        raise SystemExit(
            f"release-workflows: FAIL ({description}; missing {needle!r} in {job_name!r} job in {path})"
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
    "scripts/sync-release-pr-generated.sh",
    '"body": os.environ["ARTIFACT_SYNC_COMMIT_BODY"]',
    "GitHub-created generated artifact commits must carry the automatic-event suppression marker",
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
    "scripts/sync-release-pr-generated.sh",
    "createCommitOnBranch",
    "CI release PR sync must create generated artifact commits through GitHub server-side verified automation",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "github-verified-api",
    "release PR sync self-test must prove CI selects the GitHub-verified API mode",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    '"expectedHeadOid": os.environ["EXPECTED_HEAD_OID"]',
    "GitHub API generated artifact sync must use optimistic expectedHeadOid concurrency",
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
    "git add .release-please-manifest.premain.json cdk/.jsii cdk/lib cdk-go/apptheorycdk",
    "stable release PR sync must commit the premain manifest reset with generated release artifacts",
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
subprocess.run(["bash", "scripts/sync-release-pr-generated.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/verify-release-please-token-safety.sh"], check=True)

print("release-workflows: PASS")
PY
