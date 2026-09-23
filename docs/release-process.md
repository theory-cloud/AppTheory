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

The guard that keeps the gate a blocker is pinned first and classified second:
`scripts/verify-release-workflows.sh` pins the bytes of the guarded surface, so a change to that
surface is a finding with no parsing involved, and only then classifies what an edit is still allowed
to touch. The invoking step's `run:` body and the shell script that calls the gate are read by *one*
quoting model - single quotes, double quotes, ANSI-C `$'...'`, `$( )` and backquote substitutions,
each ending only on its own closer, with a backslash escaping the next character everywhere except a
plain single-quoted word - and that one model is shared by every reader in the guard, so a form one
reader understands cannot be read differently by the next. The readers strip comments, join line
continuations, blank heredoc bodies and multi-line quoted bodies (an embedded `awk` program is data,
not shell code), and classify what is left. What the quoting model does not cover is refused rather
than guessed at, not read past. `--self-test` runs the attack battery, one case per shape, plus a
second table of fail-closed spellings that must stay accepted; at the revision this section describes,
144 weakening shapes fail closed and 6 fail-closed spellings are accepted.

What the pins prove. Every pin is a tripwire: a pinned region may only change together with the pin
that describes it, in the same commit, so weakening the wiring is always a visible two-place edit.

| Pinned surface | How it is decided |
| --- | --- |
| `scripts/verify-release-branch.sh`, `scripts/verify-release-publish-postcondition.sh`, `scripts/verify-release-gates.sh` | pinned whole-file by SHA-256. Each holds a guarded invocation and nothing the accepted spellings table needs to tolerate, so an added line anywhere in one - a function body around the invocation, a shadowing definition, a `set +e`, a line the masking pass treats as data - is a finding. There is no construct to model here and therefore no construct to get wrong |
| The lines that name a guarded script in each shell invoker | equal, byte for byte and in file order, to the pinned invocation lines. `gov-infra/verifiers/gov-verify-rubric.sh` is pinned by line rather than by digest, because its own self-test table carries a `set +e` / `set -e` capture pair in an unrelated function that has to stay accepted |
| Each guarded step, outside its `run:` body | every raw line, byte for byte. This is where a step key lives, so an added `working-directory:`, `timeout-minutes:` or any other key this guard does not read by name changes the pinned bytes and fails |
| Each guarded step's `run:` body | the statements in normal form: comments stripped, continuations joined, whitespace collapsed, one layer of quotes removed from the argument words. Every pinned statement must be present, in order, and an extra statement is allowed only when it stands on its own line, is not joined into a list, opens no shell block or function body, and names no guarded script. That admits a `true` line, or an unrelated verifier added to the same step, and admits no spelling that wraps, gates, shadows or replaces the invocation - without the guard having had to model bash's function grammar at all |
| The inputs of the gov verifier's exempted toolchain export | `GOV_TOOLS_DIR`, `GOV_TOOLS_BIN`, `GOV_TOOLS_PY_DIR`, `GOV_TOOLS_PY_BIN`, `GOV_TOOLS_PY_COV_DIR`, `GOV_TOOLS_PY_COV_BIN`, `GOV_TOOLS_PY_RUNTIME_DIR`, `GOV_TOOLS_PY_RUNTIME_BIN` and `PATH` are each pinned to exactly one assignment with exactly the pinned text, and any other assignment to one of those names anywhere in the file fails. A text pin on the export alone leaves the value it reads free to redirect from the line above it |

What the classifier adds, where an edit has to stay allowed:

| Property | How it is decided |
| --- | --- |
| Step and job conditionals | equal to the pinned literal; any other value - `false`, `${{ false }}`, `always()`, an expression the guard does not recognise - fails |
| Step keys | read from the whole step block, because YAML key order carries no meaning: an `if:`, `continue-on-error:`, `shell:` or `env:` written after the `run:` body is the same key as one written before it, and a repeated key fails |
| A repeated key at workflow or job-name level | refused. YAML keeps the last value for a repeated key and the runner resolves that one, while every reader here reads the first occurrence - so a second `defaults:`, or a second job carrying the pinned job's name with `if: false`, is a finding rather than a job the guard classified while the runner skipped another |
| Keys spelled `key : value`, `"key": value` or `? key` | read as the same key - YAML does not require the colon to touch the key, and a quoted or explicit key is the same mapping key - and any of those spellings at any indentation, workflow level included, fails outright, so a key this guard does not enumerate cannot hide behind a spelling it never read |
| The invocation | first on its line, unnegated, at top level, naming the script directly, with its exit status governing what follows |
| Arguments | one of the pinned literal argument vectors; a variable, a `${{ }}` expression, an expansion or a substitution fails |
| A tolerated `|| return N` / `|| exit N` tail | accepted only when nothing follows it in the same list, so `|| exit 1 &`, `|| exit 1; true` and `|| exit 1 \| tee log` all fail |
| An invocation inside a function definition | accepted only for a function pinned as a host, and only when every call of that host is fail-closed in its own right - at file level, or carrying a `|| exit N` tail that leaves the shell whatever the caller's context is; any other function holding an invocation, or any other call of a pinned host, fails, because bash ignores errexit for every command in a function entered from a condition. A definition is recognised in both of bash's spellings - `name ()` and `function name`, with the parentheses optional in the second - and a body this model cannot place (a subshell body, a conditional body) is sealed to the end of the body rather than skipped, so its contents can never read as top level |
| `env:` at step, job and workflow level | must not set a variable that decides which program runs or how a shell starts: `PATH`, `CDPATH`, `BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS` or a `BASH_FUNC_*` exported function; a flow-style env mapping fails |
| `defaults.run` at workflow and job level | `shell` must keep errexit and `working-directory` must be unset. GitHub resolves both for every `run:` step below them, before the step's own keys, so either reaches a guarded step whose own lines are byte-identical to the pin |
| The whole run body or shell file | must not clear errexit in the region that can run the invocation, shadow `bash`, `exit`, `set`, `trap` or the script path with a function or alias, install a trap, reassign one of those same variables in-shell, export a `BASH_FUNC_*` function definition into the environment, re-pin a command name with `hash -p`, or load code into the shell (`source`, `.`, `eval`) or move it (`cd`, `pushd`) so that the invocation's own line stays pinned while the command it runs does not |
| Step discovery | a list indicator is a `-` followed by at least one space, and a step may carry its keys after any amount of it: `- name: X`, `-   name: X` and `-   run: \|` are the same step, and each is discovered and classified rather than skipped |

The `env:` row is checked at workflow, job and step level, and the shell-state row is checked for the
guarded steps and for every shell script that calls the gate, including
`gov-infra/verifiers/gov-verify-rubric.sh`. That generated verifier legitimately exports `PATH` for
its pinned toolchain, installs one `RETURN` trap, loads its own three helper libraries, runs from the
repository root, and evaluates the dispatch command in `run_check`; it also captures exit codes with
`set +e` / `set -e` pairs in functions of its own, and each of the three shell invokers opens by
`cd`-ing to the repository root through its own path. Those statements - and only those - are
exempted by their full text, so a different `PATH` value, a second trap, a second `source`, a
different `cd` or a shadowing definition still fails, and the errexit check is scoped to the
file-level statements plus the body of the function that holds the invocation. Its own check is
reached by name rather than by a call the guard can follow, so that dispatch is pinned whole: the
assignment that names the check, the `run_check` statement that dispatches it, and the
`set -euo pipefail` inside `run_check` that makes the dispatched command fail closed. The toolchain
that exemption covers is closed on its inputs separately, in the pin table above.

The guard's own invocations go through the same classification - the release/security step in `ci.yml`,
the release preflights in `prerelease.yml` and `release.yml`, `scripts/verify-release-gates.sh` and
`gov-infra/verifiers/gov-verify-rubric.sh` - so weakening a call of the guard fails as loudly as
weakening a call of the gate it guards. Call sites are discovered from the workflow text rather than
from a fixed list, so a call added in a new step is classified too, and a new step may not carry a
conditional the guard has no pin for. In a shell invoker there is no unpinned call site: the guarded
scripts are named on exactly the pinned lines of exactly those files, and a name anywhere else there
is a finding. In a workflow, a call site in a *new* step is discovered and classified rather than
pinned, because the accepted table requires an added step to stay accepted - so what a workflow pin
fixes is the pinned wiring itself, and what covers everything else is the classification of the new
call site.

Every property above is decided positively against a pinned value or a pinned byte, so within the
pinned wiring an unrecognised value fails closed. Four YAML forms are refused outright rather than
read past, because the guard reads literal text and the runner resolves the document: a `<<:` merge
key, a second document in one workflow file, a YAML alias (`*name`, which re-points a value at a node
defined elsewhere), and a flow-style step mapping (`- {name: ..., run: ...}`) that names the guarded
script. An anchor (`&name`) is inert on its own and is not refused.

Each claim in the two tables above has a battery case behind it in `--self-test`, and a claim with no
case behind it is removed rather than kept: the pin claims by the shapes that add a statement to a
pinned run body, add a step key, edit a digest-pinned file, add a line naming a guarded script or
redirect a pinned toolchain input; the shell-state and loading claims by the shadowing, trap,
errexit, `PATH`, `source`, `.`, `eval`, `cd`, `hash -p` and `BASH_FUNC_*` cases; the repeated-key
claim by the duplicate job-name and second-`defaults:` cases; the quoting claim by the ANSI-C and
backquote cases; the key-spelling claim by the pre-colon, quoted and explicit-key cases at step, job
and workflow level; the `defaults.run` claim by the workflow-level, job-level and step-level
`working-directory` cases and the workflow-level `shell` case in a workflow that has no pinned job;
the function-host claim by the `()`-less, subshell, conditional and brace-poisoned bodies; and the
step-discovery claim by the spaced flow-style and spaced unnamed-step cases. The accepted table holds
the mirror image - the spellings that must stay accepted, including a trailing comment, a next-line
`true`, a quoted `--self-test`, an unrelated `set +e`/`set -e` pair, an inert anchor and an unrelated
verifier added to a pinned step - so a pin that starts over-blocking fails the self-test as loudly as
a classifier that starts missing.

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
