---
title: Release Process
---

# AppTheory Release Process

AppTheory has one release train. The valid cycle is:

1. Merge feature and fix PRs into `staging`.
2. Promote `staging` to `premain` to create the next release candidate.
3. Promote `premain` to `main` to create the stable release.
4. Back-merge `main` into `staging` before any later staging work or promotion.

No branch may skip a leg of that cycle. `premain` only receives `staging`, `main` only receives `premain`, and the only release-branch PR into `staging` is the `main` back-merge after a stable release. Ordinary PRs targeting `staging` must contain the current `main` baseline before they are opened or merged.

## Branch responsibilities

| Branch | Role | Allowed incoming changes |
| --- | --- | --- |
| `staging` | Integration branch for all normal work. | Feature/fix PRs that contain current `main`; `main` back-merges after stable releases. |
| `premain` | Prerelease branch. | Human `staging` promotion PRs and generated `release-please--branches--premain` RC PRs only. |
| `main` | Stable release branch. | Human `premain` promotion PRs and generated `release-please--branches--main` stable PRs only. |

Release automation is driven by Conventional Commits. `feat:` and `fix:` entries ship; `docs:`, `test:`, `chore:`, and `refactor:` do not trigger a release by themselves. Version state must remain aligned across `VERSION`, TypeScript and CDK package manifests and lockfiles, Python metadata, and both Release Please manifests.

The full rubric runs only for PRs targeting `staging` and optional manual `workflow_dispatch` CI runs. Manual CI dispatch defaults to running the rubric; generated release-PR artifact sync dispatches CI with the full rubric disabled and waits only for release hygiene/build checks. `premain` and `main` run release hygiene, branch version sync, release-branch provenance, package build, and publish postcondition checks; they must not run the full rubric on release publish paths.

## Full cycle checklist

### 1. Integrate on `staging`

- Open the PR against `staging`.
- Verify `origin/main` is an ancestor of the PR head before opening or merging:

  ```bash
  git fetch origin main staging premain
  git merge-base --is-ancestor origin/main HEAD
  ```

- Run the normal validation for the change, at minimum `make test` and any issue-specific verifier.
- Merge only after CI is green.

### 2. Promote `staging` to `premain`

- Open a PR from `staging` into `premain`.
- Do not retarget the PR from another branch.
- CI must run the release train promotion gate and branch version sync checks.
- The prerelease Release Please workflow must create or update the release-candidate PR. A Release Please no-op is a failed RC gate; annotated `VERSION` markers such as `# x-release-please-version` are ignored only after the leading RC semver is validated.
- The release-candidate PR remains draft-locked while generated CDK artifacts are synchronized and required checks run.
- Merge the release-candidate PR only after generated artifacts are in sync and all required checks are green.
- The prerelease publisher creates immutable assets for the `vX.Y.Z-rc.N` GitHub Release.

### 3. Promote `premain` to `main`

- Open a PR from `premain` into `main`.
- CI must verify the promotion is `premain` → `main` and that release manifests are synchronized.
- The stable Release Please workflow must create or update the stable release PR. A Release Please no-op is a failed stable gate.
- The stable release PR must reset `.release-please-manifest.premain.json` to the stable version and include generated CDK artifact sync before it becomes ready.
- Merge the stable release PR only after required checks pass.
- The stable publisher creates immutable assets for the `vX.Y.Z` GitHub Release.
  `main` owns stable releases only; RC-shaped stable PR titles, versions, or tags are rejected.

### 4. Back-merge `main` to `staging`

- Open a PR from `main` into `staging` immediately after the stable release.
- Merge it before the next staging PR or promotion.
- This keeps the stable Release Please manifest and the premain Release Please state synchronized for the next cycle.
  There is no post-release CI direct-push sync or automated protected-branch backmerge.

## Forbidden recovery actions

Do not use any of these actions to recover a release lane:

- Force-pushing `main`, `premain`, `staging`, release PR branches, or milestone branches.
- Retagging, deleting, or recreating release tags.
- Editing, deleting, or overwriting a published GitHub Release or its assets.
- Publishing AppTheory to npm, PyPI, or any registry outside GitHub Releases.
- Bypassing Release Please, generated artifact sync, version alignment, branch version sync, or the release train promotion gate.
- Merging a stale Release Please PR after `main` has advanced.
- Manually marking protected checks successful or weakening workflow permissions so a release PR can self-attest.
- Running a stable release from `staging` or a prerelease from `main`.
- Creating manual tags or GitHub Releases instead of letting the generated Release Please PR merge publish the expected tag.

Published GitHub Releases are immutable. If a published release is wrong, the recovery is a new version moving through the normal cycle, not mutation of the old release.

## Safe operational recovery path

When the release lane is blocked, recover by preserving evidence and re-entering the same cycle:

1. Diagnose without mutation.

   ```bash
   bash scripts/diagnose-release-state.sh --live
   bash scripts/verify-release-state.sh --live
  bash scripts/verify-release-workflows.sh
  bash scripts/verify-ci-rubric-enforced.sh
   ```

2. Classify the blocker.
   - Draft GitHub Release with missing or partial assets: rerun the same publisher workflow; the publisher replaces draft assets safely and verifies branch provenance before publication.
   - Published GitHub Release already exists: rerun the publisher only to verify immutable assets match the source build; do not upload or edit assets.
   - Stale Release Please PR: regenerate or sync Release Please state from the current branch baseline; do not merge the stale PR.
   - Promotion drift: recreate the promotion PR from the valid branch heads in the cycle.
   - Back-merge drift: merge `main` back into `staging` before accepting further staging work.

3. Re-run the deterministic release verifiers before retrying a merge or publisher workflow.

   ```bash
   bash scripts/verify-release-state.sh --self-test
   bash scripts/verify-release-train-promotion.sh --self-test
   bash scripts/verify-release-workflows.sh
   bash scripts/verify-ci-rubric-enforced.sh
   make test
   ```

4. If the framework cannot express the needed recovery, add a verifier-backed release-process change first. Do not create a one-off manual path around the train.
