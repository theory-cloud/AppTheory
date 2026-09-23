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

Generated release PRs have one CI trigger. Release Please version commits and generated-artifact sync commits carry
`[skip ci]` in the commit body so their automation-originated `pull_request` `opened` and `synchronize` events do
not create stale or duplicate CI runs. After the final generated-artifact head is visible and signature-verified,
the sync workflow starts one explicit `workflow_dispatch` CI run for that exact head, waits for every required
context (including the release-train promotion and release/security gates), rechecks that the head is unchanged,
and only then marks the PR ready. The dispatch carries the exact release PR number; the promotion gate loads that
PR through GitHub's API and fails unless its repository, branch, and SHA match the dispatched ref. The skip marker
does not bypass validation: it suppresses only automatic `push`/`pull_request` triggers; the explicit CI dispatch
remains required and fails closed.

Skipped full-rubric and deterministic-build contexts are not release/security proof. The `Release/security gates` CI job is unconditional and branch-protection-compatible; it verifies release supply-chain wiring, release branch signature history, Release Please provenance self-tests, CI rubric enforcement, workflow invariants, and deterministic release-cycle fixtures even when the full rubric is intentionally skipped.

### Release credential boundary

Release Please credentials are environment-only secrets. They must never be placed in shell, npm, Node, or
operating-system process arguments. `scripts/run-release-please-pr.sh` is the only supported Release Please CLI
entry point. Its transport stages the pinned `release-please@17.1.3` package in an npm process from which
`RELEASE_PLEASE_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` have all been removed. Only after npm exits does the
launcher provide `RELEASE_PLEASE_TOKEN` to the Release Please parser in-process; ambient GitHub credentials are
removed from that process as well. The package staging step also disables lifecycle scripts and fails closed if
any GitHub credential reaches the npm boundary.

Do not replace this path with `npx`, `npm exec`, or a direct `release-please --token ...` invocation. npm can log
its command arguments, and operating-system process arguments are observable outside the invoking process. Run
`bash scripts/verify-release-please-token-safety.sh` to exercise the sentinel regression test. The release
workflow verifier runs that test automatically.

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
- For v2+, the same serialized publisher creates the root `vX.Y.Z-rc.N` tag and nested
  `cdk-go/apptheorycdk/vX.Y.Z-rc.N` Go module tag only when absent, proves both target the exact RC commit, and
  resolves both modules at the exact version through direct VCS lookup before the draft release becomes public.

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
- For v2+, stable publication applies the same create-only two-tag transaction:
  `vX.Y.Z` and `cdk-go/apptheorycdk/vX.Y.Z` must target the exact same stable release commit. Any conflicting
  existing ref fails closed; neither tag is moved, deleted, or recreated.

### 4. Back-merge `main` to `staging`

- Open a PR from `main` into `staging` immediately after the stable release.
- Merge it before the next staging PR or promotion.
- This keeps the stable Release Please manifest and the premain Release Please state synchronized for the next cycle.
  There is no post-release CI direct-push sync or automated protected-branch backmerge.

## apptheory-init template/release pairing gate

`apptheory-init` scaffolds pin `@theory-cloud/apptheory-cdk` to the GitHub release asset for
`v` + `VERSION` and declare their own `aws-cdk-lib`/`constructs` versions. npm installs both, so the
template pins must pair with the `peerDependencies` declared by the CDK asset for that tag. When they
drift, `npm install` fails ERESOLVE in every generated project.

`scripts/verify-scaffold-examples.sh` packs `cdk/` from the working tree, so it only proves the
templates match the tree the gate runs on. It cannot see release-process skew: a tree whose `VERSION`
already names a published release with different peers, a template asset URL naming a different tag
than `VERSION` substitutes, or a release packed at a version other than the one the templates point at.

`scripts/verify-release-pairing.sh` closes that class. It packs (or downloads) the CDK artifact,
renders the templates with the real scaffolder, and fails closed unless every template names the
release asset for the tag `VERSION` substitutes and its pins intersect that artifact's declared
`peerDependencies`. Range syntax it cannot decide is a failure, never a pass.

The checker decides ranges the way npm semver does, including the desugaring npm applies to a partial
body under an operator: `>2.269` means `>=2.270.0` and `<=2.269` means `<2.270.0`, neither of which is
the `2.269.0` bound. It rejects the version syntax npm itself refuses (leading-zero components,
components above `Number.MAX_SAFE_INTEGER`) and treats a pin no version can satisfy - any range whose
ceiling falls below `0.0.0` - as empty. Shapes it declines to decide (prerelease and build ranges,
unions, `x`/`*` bodies under an operator, and the operator forms npm accepts only with the body
attached, such as `>= 2.269`) fail closed rather than passing, which is deliberate: for a handful of
degenerate ranges npm's own `intersects` disagrees with its `minVersion`/`satisfies`, and this gate
follows the satisfiability answer, not the intersection artifact.

The gate is a blocker, not an advisory, in four places:

| Where | What it proves |
| --- | --- |
| `ci.yml` `release-security-gates` (runs on every PR, including generated release PRs) | The generated RC/stable release-please PR head - the tree that will be tagged - pairs its templates with the packed candidate |
| `prerelease-pr.yml` / `release-pr.yml`, before generated artifact sync | The branch about to generate a release PR has not drifted |
| `scripts/verify-release-branch.sh`, on every publish path in the tagged tree before assets are built | The release-candidate tarball for the tag pairs with the shipped templates |
| `scripts/verify-release-publish-postcondition.sh` `complete` phase | The release this run published pairs its immutable asset with the shipped templates |

Run it locally with `./scripts/verify-release-pairing.sh` (default), `--self-test` (both-directions
proof), or `--published` (download and verify the published asset for the current `VERSION`). The
download is bounded by a connect timeout and a maximum transfer time so a stalled release host fails
the gate promptly, and a download failure reports the HTTP status or timeout rather than assuming the
asset is missing.

The guard that keeps the gate a blocker is `scripts/verify-release-workflows.sh`, and it decides by
bytes. Rounds 1-4 modelled what an edit *meant* - bash's quote contexts, bash's function bodies,
YAML's key spellings - and admitted an extra statement they judged inert. Every round found a spelling
the model lacked, and the last round found that the admission rule itself was the hole: an `exit 0`
written as the first line of a pinned run body leaves every pinned statement below it in place and
stops the gate from ever mattering. There is no model and no admission rule any more.

What "pinned" means here. A guarded region is decided by its exact bytes. The only tolerated drift is
trailing whitespace on a line and a CRLF line ending, so an ordinary editor does not trip the guard;
every other byte is compared as it stands. A guarded region may change only together with the pin that
describes it, in the same commit. That is deliberately a visible two-place edit, and updating the pin
in the same pull request is the intended workflow for any intentional change to a guarded region -
there is no edit to one that is admitted without it.

`--self-test` runs the attack battery, one case per shape, each naming the pin class it must fail on,
plus a table of shapes that must stay accepted. At this revision 170 weakening shapes fail closed and
8 fail-closed spellings are accepted, and the legitimate wiring at HEAD is accepted as the baseline
before any attack is tried - the guard asserts those two counts against this document, so the numbers
here cannot drift from the battery.

What is pinned, and what each pin is behind:

| Pinned surface | How it is decided |
| --- | --- |
| The workflow-level configuration of each guarded workflow - every raw line above its first `jobs:` | byte for byte. `on:`, `permissions:`, `concurrency:`, `env:`, `defaults:` and anything else at that level is resolved by the runner before any step below it, so the region is pinned whole rather than key by key. Battery: a workflow-level key added above `jobs:`, a workflow-level `defaults:` that drops errexit, a workflow-level `env: CDPATH`, the quoted-key spellings, a YAML merge key and a second YAML document |
| Every workflow-level key, declared exactly once | a repeated root key is refused rather than read past: YAML keeps the last value, and the runner resolves the one the guard never read. Battery: a second `jobs:` mapping added below the first |
| Each guarded job - the whole block, from its key line to the next job | byte for byte, including the job's `if:` (present with exactly these bytes, or absent), every job-level key, and every step of the job. The steps of one job share a runner and a workspace, so a sibling step that runs first can rewrite the guarded script and leave the pinned step's own bytes - and both of its invocations - exactly as pinned. Battery: `if: false` and `continue-on-error` on the job, a job-level `env: PATH`, a job-level `defaults`, an action reference changed inside a pinned job, a sibling step that truncates the paired gate, and the step-moved-into-another-job case |
| A pinned job key declared exactly once | YAML keeps the last definition of a repeated key, so a second job carrying the pinned key is refused. Battery: the duplicate job-name case |
| Each guarded step - the whole block, keyed by (workflow, job, step name) | byte for byte: the step's name, every key it carries and its complete `run:` body. The block runs to the next step or the next job, so a key appended after the `run:` body is part of the same block and changes it. Battery: `exit 0` and `exec true` written first in the body, the quoted-`<<` mask over a shadowed `bash`, the glob-truncate case, negation, list operators, usage flags, backslash continuations, a heredoc-smuggled invocation, a step key appended after the body, and the step-moved-to-another-job case |
| A guarded step is inside the job its pin names | the pin is keyed by (workflow, job, step), so moving it - into another job, or into a job that never runs - fails even when its own bytes are untouched. Battery: the step-verbatim-into-an-`if: false`-job case |
| The four shell invokers that can reach the gate or the guard | whole-file SHA-256: `scripts/verify-release-branch.sh`, `scripts/verify-release-publish-postcondition.sh`, `scripts/verify-release-gates.sh` and `gov-infra/verifiers/gov-verify-rubric.sh`. Round 4 pinned the fourth by invocation line only, to keep tolerating a `set +e`/`set -e` pair inside one of its own self-tests - a tolerance this construction withdraws, so the whole file is pinned now. Battery: every shell-invoker case, plus `set +e` and a `bash()` definition added to the GovTheory verifier |
| The transitive closure of the GovTheory verifier's toolchain `PATH` export | `SCRIPT_DIR`, `REPO_ROOT`, `GOV_INFRA`, the eight `GOV_TOOLS_*` names and `PATH` are each pinned to exactly one assignment with exactly the pinned text, and any other assignment to one of those names anywhere in the file fails. Round 4 pinned the export's own text and the names below it but left `GOV_INFRA` - which `GOV_TOOLS_DIR` reads - free, so one appended assignment put another `bash` first on `PATH` while every pinned statement stayed byte-identical. Battery: `GOV_INFRA`, `REPO_ROOT` and `SCRIPT_DIR` each re-pointed |
| Every occurrence of a guarded script name in the sweep set - every file under `.github/`, `Makefile`, a root `package.json` when present, and the invoker scripts | admitted from three places and nowhere else: inside a digest-pinned invoker, inside a pinned step, or on a line byte-identical to a pinned invocation line. The third is additive strengthening - running a pinned gate from somewhere else cannot make the pinned step stop running - and it is admitted outside the five guarded workflows only, because one of those workflows is the artifact the required release context is keyed on. There is no composite action, `Makefile` or `package.json` call site today, and the sweep is what keeps that true. Battery: a flow-style step mapping, a YAML alias, a step written with extra list-item space, a call site in a new step, a call site added to the `Makefile`, and a call site added to a workflow that is not one of the five |

An occurrence sweep matches the guarded script's *name*, so it does not see a glob, and this is the
sweep's one limit, stated rather than glossed: `printf '' > scripts/verify-release-pa*` names no
guarded script. Inside a pinned step or a pinned job it is a finding either way, because those regions
are pinned by bytes and the battery carries both shapes; in a file that holds no pin it is not seen.
That is harmless for the context the required release gate runs in, because only the steps of one job
share a runner and a filesystem - a step in another job, or in another workflow file, cannot reach the
workspace the pinned step runs in.

What is **not** pinned anywhere in this repository, said plainly. These three files are read by nothing
here, so a change to one of them is invisible to every gate in this repository. Their integrity is
rooted in pull-request review and in signed commits, and in nothing else:

| File | Why it is not pinned |
| --- | --- |
| `scripts/verify-release-workflows.sh` | This guard. A file cannot pin its own bytes: a weakened copy would carry the weakened pin with it, so a self-pin would prove nothing. |
| `scripts/verify-ci-rubric-enforced.sh` | It substring-checks `ci.yml` (its line 101 asserts that the release/security step names the guard). The guard does not read it. |
| `scripts/verify-release-pairing.sh` | The gate this guard protects. The guard pins where the gate is invoked, in which job and under what bytes; it does not pin the gate's own file. |

Those three rows are asserted by the battery rather than only claimed: three accepted cases edit
exactly those files and require that no finding is produced, so the disclosed boundary cannot quietly
become a claim that the guard covers them.

Round 4's accepted table is gone, and the claims it carried with it. Each of its six entries was
admitted by the freedom to add a statement to a pinned run body or an inert section to a workflow, and
every one of them changes the bytes of a pinned region or names a guarded script outside one: a
trailing comment on the invocation line, a `true` line after it, a quoted `--self-test`, an unrelated
`set +e` / `set -e` pair inside the GovTheory verifier, an `x-` section holding a weakened invocation,
and an unrelated verifier added to a pinned step. All six now fail closed, they are carried in the
battery as attack cases rather than as accepted ones, and the workflow for any of them is the
documented two-place edit - change the region and the pin together - rather than an admission.

Every row of the tables above has a battery case behind it in `--self-test`, and a row with no case is
removed rather than kept. The pin rows are carried by the shapes that add or edit a byte of a pinned
region: a statement added to a pinned run body, a step key appended after the body, a key added above
`jobs:`, a key added to a pinned job, a sibling step added to a pinned job, a repeated job key, a
repeated root key, an edit to one of the four digest-pinned invokers, an assignment to a name in the
pinned toolchain closure, and a guarded script name written outside every pin. The accepted table holds
the mirror image, so a pin that starts over-blocking fails the self-test as loudly as a pin that starts
missing: the legitimate wiring at HEAD (asserted before any attack is tried), trailing whitespace on a
pinned line, CRLF line endings, a byte-identical pinned invocation line added to the `Makefile`, a key
added to a job that holds no pin, and the three disclosed boundaries above.

The guard's own invocations go through the same pins - the release/security step in `ci.yml`, the
release preflights in `prerelease.yml` and `release.yml`, `scripts/verify-release-gates.sh` and
`gov-infra/verifiers/gov-verify-rubric.sh` - so weakening a call of the guard fails as loudly as
weakening a call of the gate it guards. The three YAML forms that the runner would resolve differently
from a literal reading are refused rather than read past: a `<<:` merge key, a second document in one
workflow file, and a YAML alias (`*name`, which re-points a value at a node defined elsewhere). In the
pinned wiring each of them sits inside a pinned region, so each is an ordinary byte change as well as a
refused form.

The already-published `v4.2.4` asset declares `aws-cdk-lib 2.269.0` and cannot be changed. The gate
exists so `4.2.5` and later either ship paired or fail before the release becomes public.

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
- Moving, deleting, force-updating, or manually repairing either the root release tag or the nested
  `cdk-go/apptheorycdk/vX.Y.Z[-rc[.N]]` Go module tag.
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
   - Root or nested Go tag missing after a partial publisher run: rerun the same serialized publisher. It creates
     only the absent ref at the already-verified release commit, retains any same-commit ref, and then proves exact
     root/CDK module resolution.
   - Root or nested Go tag points at another commit: do not retag. Preserve the conflicting evidence and cut a new
     version through the normal train.
   - Published GitHub Release already exists: rerun the publisher only to verify immutable assets and both Go module
     refs match the source build; do not upload or edit assets.
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
   bash scripts/publish-go-module-tags.sh --self-test
   bash scripts/verify-go-module-tags.sh --self-test
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
stages only `.release-please-manifest.premain.json`, `cdk/.jsii`, `cdk/lib`, `cdk-go/go.mod`, `cdk-go/go.sum`, and
`cdk-go/apptheorycdk`, then runs plain `git commit -m "chore(release): sync generated release artifacts"`. It does not set
`user.signingkey`, replace the signing program, import keys, or add passphrases. If the normal local signing
configuration does not produce a locally trusted-good signature, the script fails before pushing and reports the
signature status.

After the signed sync commit is pushed, the script waits for the release PR head, dispatches the release hygiene/build checks with the full rubric disabled, and marks the release PR ready only after the generated-artifact head still matches and required checks pass.
