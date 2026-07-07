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

Release automation is driven by Conventional Commits. `feat:` and `fix:` entries ship; `docs:`, `test:`, `chore:`, and `refactor:` do not trigger a release by themselves. Version state must remain aligned across `VERSION`, TypeScript and CDK package manifests and lockfiles, Python metadata, and the active Release Please manifest for the release lane. Stable releases align both Release Please manifests to the stable version; prerelease branches keep `.release-please-manifest.json` on the last stable version while `.release-please-manifest.premain.json` tracks the RC version.

Upgrade policy is maintained separately from the generated changelog. When a minor line changes runtime behavior, deployment defaults, dependency floors, generated-artifact expectations, or deprecation posture, update `UPGRADING.md` in the same change or release-prep PR. The changelog lists commits; `UPGRADING.md` lists consumer action and per-line compatibility notes.

The full rubric runs only for PRs targeting `staging` and optional manual `workflow_dispatch` CI runs. Manual CI dispatch defaults to running the rubric; generated release-PR artifact sync dispatches CI with the full rubric disabled and waits only for release hygiene/build checks. The standalone `Verify deterministic builds` CI job also runs only for PRs targeting `staging`; generated release PR sync must not require or wait for that skipped context. `premain` and `main` run release hygiene, branch version sync, release-branch provenance, package build, and publish postcondition checks; they must not run the full rubric or deterministic-build job on release publish paths.

Skipped full-rubric and deterministic-build contexts are not release/security proof. The `Release/security gates` CI job is unconditional and branch-protection-compatible; it verifies release supply-chain wiring, release branch signature history, Release Please provenance self-tests, CI rubric enforcement, workflow invariants, and deterministic release-cycle fixtures even when the full rubric is intentionally skipped.

Generated release PR artifact sync commits on both `release-please--branches--premain` and
`release-please--branches--main` are product release-automation commits. CI is not a signing key holder
and no workflow-held private signing key exists. The sync workflow draft-locks the release PR, regenerates
artifacts, proves the diff is limited to the generated release-artifact allowlist, and, when a commit is
needed, creates exactly one GitHub GraphQL `createCommitOnBranch` commit with
`chore(release): sync generated release artifacts` and `expectedHeadOid` set to the fetched release-branch
head. GitHub signs that commit server-side, the workflow fetches the resulting head, and the release branch
signature gate must accept it as GitHub verified-valid before required CI is dispatched or the release PR is
marked ready. The workflow does not `git push` a CI-created artifact commit, import signing material, set git
signing config, or use private signing secrets.

Release Please commits and generated artifact sync commits created by GitHub automation are GitHub-verified
unless local evidence proves a stronger signer. Do not describe them as Aron/canonical-key signed merely
because GitHub marks them verified. Delegate implementation commits for normal PRs remain locally signed by
the steward/operator under the repository's existing signing configuration; the GitHub-verified release
automation commits are limited to generated release PR version/artifact synchronization.

The signed-history repair boundary is the repaired branch base `c723c42c71d9220f49702db965d4deffff6183f1`. Protected branch and release-please branch security gates reject commits in the repaired branch ranges unless the commit is either locally trusted-good (`%G?=G`) or GitHub-verified with `verified=true` and `reason=valid`. GitHub Actions runners may report SSH-signed commits as `local_status=N` when they lack the local `gpg.ssh.allowedSignersFile`; that state is accepted only with GitHub verified-valid evidence, and true unsigned commits still fail closed. Immutable v1.15.x release tags are an accepted residual exception: `v1.15.0` contains two historical unsigned generated sync commits, `v1.15.1` contains four, and `v1.15.2` contains six. Those published tags, releases, notes, metadata, and assets must not be changed; recover forward through the normal `staging` → `premain` → `main` train.

Safe provenance claims are scoped: repaired branch tips from `c723c42c71d9220f49702db965d4deffff6183f1`
forward are guarded against commits that are neither locally trusted-good nor GitHub verified-valid, and
GitHub API Release Please/generated artifact sync commits may be called GitHub-verified when the verification
API reports `verified=true` and `reason=valid`. Unsafe claims are rejected: do not claim all released tag
history is signed, do not claim GitHub-verified API commits are Aron/canonical-key signed without local
evidence, and do not claim CI can sign generated sync commits by holding private signing material.

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
- When the release includes a change to `release-please-config*.json` `extra-files` entries, watch the first generated
  `release-please--branches--premain` RC PR deliberately. Do not claim proof from static config alone: verify the
  generated PR actually rewrites every configured JSONPath/TOML/generic file, including example
  `packages['../../../cdk'].version` lockfile entries, and that `scripts/verify-version-alignment.sh` passes on the
  generated head. Record the RC PR URL and check output in the promotion notes.
- Merge the release-candidate PR only after generated artifacts are in sync and all required checks are green.
- The prerelease publisher creates immutable assets for the `vX.Y.Z-rc.N` GitHub Release.

### 3. Promote `premain` to `main`

- Open a PR from `premain` into `main`.
- CI must verify the promotion is `premain` → `main` and that release manifests are synchronized.
- The stable Release Please workflow must create or update the stable release PR. A Release Please no-op is a failed stable gate.
- The stable release PR must reset `.release-please-manifest.premain.json` to the stable version and include generated CDK artifact sync before it becomes ready.
- Generated release-artifact sync commits are created automatically by the shared sync script as GitHub-verified
  product-automation commits. Do not add CI-held signing secrets; the workflow token creates the server-side signed
  `chore(release): sync generated release artifacts` commit through `createCommitOnBranch`, then verifies the new
  range before the PR can become ready.
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
- Adding CI-held private signing material so workflow runners can manufacture generated release-artifact sync commits.

Published GitHub Releases are immutable. If a published release is wrong, the recovery is a new version moving through the normal cycle, not mutation of the old release.

## Safe operational recovery path

When the release lane is blocked, recover by preserving evidence and re-entering the same cycle:

1. Diagnose without mutation.

   ```bash
   bash scripts/diagnose-release-state.sh --live
   bash scripts/verify-release-state.sh --live
   bash scripts/verify-release-workflows.sh
   bash scripts/verify-ci-rubric-enforced.sh
   bash scripts/verify-release-branch-signatures.sh --self-test
   ```

2. Classify the blocker.
   - Draft GitHub Release with missing or partial assets: rerun the same publisher workflow; the publisher replaces draft assets safely and verifies branch provenance before publication.
   - Published GitHub Release already exists: rerun the publisher only to verify immutable assets match the source build; do not upload or edit assets.
   - Stale Release Please PR: regenerate or sync Release Please state from the current branch baseline; do not merge the stale PR.
   - Generated artifact sync pending: keep the release PR draft and rerun the release PR sync workflow so it can
     create the GitHub-verified generated artifact commit and prove the signature range. Use the local signed
     fallback below only when GitHub automation is unavailable and an operator deliberately performs the offline
     recovery. Do not configure workflow-held private signing material, do not rewrite existing released commits,
     and do not bypass signing.
   - Promotion drift: recreate the promotion PR from the valid branch heads in the cycle.
   - Back-merge drift: merge `main` back into `staging` before accepting further staging work.

3. Re-run the deterministic release verifiers before retrying a merge or publisher workflow.

   ```bash
   bash scripts/verify-release-state.sh --self-test
   bash scripts/verify-release-train-promotion.sh --self-test
   bash scripts/verify-release-workflows.sh
   bash scripts/verify-ci-rubric-enforced.sh
   bash scripts/verify-release-branch-signatures.sh
   make test
   ```

4. If the framework cannot express the needed recovery, add a verifier-backed release-process change first. Do not create a one-off manual path around the train.

## Emergency/offline local signed generated-artifact sync fallback

The primary path is automated: the release PR workflow creates the generated artifact sync commit as a
GitHub-verified `createCommitOnBranch` product-automation commit and then dispatches the required checks. Use
this local path only as an emergency/offline fallback for generated release PR branches that are already open and
draft-locked, for example when GitHub automation is unavailable and a human operator explicitly accepts the
offline recovery. It is the same release train; it is not a direct push to `premain` or `main`.

```bash
git fetch origin
bash scripts/sync-release-pr-generated.sh --local-signed-sync release-please--branches--premain
# or:
bash scripts/sync-release-pr-generated.sh --local-signed-sync release-please--branches--main
git log --show-signature -1
git verify-commit HEAD
```

The script starts from a clean checkout, fetches the release PR branch, regenerates only release artifact files,
stages only `.release-please-manifest.premain.json`, `cdk/.jsii`, `cdk/lib`, and `cdk-go/apptheorycdk`, then
runs plain `git commit -m "chore(release): sync generated release artifacts"`. It does not set
`user.signingkey`, replace the signing program, import keys, or add passphrases. If the normal local signing
configuration does not produce a locally trusted-good signature, the script fails before pushing and reports the
signature status.

After the signed sync commit is pushed, the script waits for the release PR head, dispatches the release hygiene/build checks with the full rubric disabled, and marks the release PR ready only after the generated-artifact head still matches and required checks pass.
