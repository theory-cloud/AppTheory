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
bytes. Rounds 1-5 modelled what an edit *meant* - bash's quote contexts, bash's function bodies, YAML's
root keys and key spellings, a job's span, a step's span - and admitted whatever the model could not
see. Every round produced a spelling the model lacked: an `exit 0` written first in a pinned run body,
a root-level `env:` appended below `jobs:`, a quoted `"jobs":` mapping, a job key written twice under
two spellings, a whole trailing job that absorbed an append. There is no model and no admission rule
any more, and no region logic either: the five workflows are pinned as whole files.

What "pinned" means here. A pinned file is decided by its exact bytes - its whole-file SHA-256. There
is no tolerance, for whitespace or for line endings: a CRLF line ending, a byte-order mark or a
trailing space is a byte change like any other, and it fails closed with a message that says so. The
guard probes its own reader for byte-fidelity before it compares anything, because a
universal-newline reader - which hands back `\r\n` as `\n` - is the same tolerance by another name.
The
fix for a file whose editor wrote different line endings is to normalise the file, and that
normalisation is an ordinary visible edit. A pinned file may change only together with the pin that
describes it, in the same commit: that is deliberately a visible two-place edit, and the guard reports
the new digest to paste, so the pin update is mechanical. Any edit to a pinned file requires the pin
update in the same pull request - no edit to a pinned file is admitted without one.

`--self-test` runs the attack battery, one case per shape, each naming the class it must fail on, plus
a table of shapes that must stay accepted. At this revision 218 weakening shapes fail closed and 4
fail-closed spellings are accepted, and 2 accepted pinned-file changes are admitted with the pin update
that goes with them, and the legitimate wiring at HEAD is accepted as the baseline before any attack
is tried - the guard asserts all three counts, the size of the closure, the spelling table, the
executor sentence and the sentences below against this document, so what is written here cannot drift
from the artifact behind it.

What is pinned, and what each pin is behind:

| Pinned surface | How it is decided |
| --- | --- |
| The five workflows the release train runs - `ci.yml`, `prerelease-pr.yml`, `release-pr.yml`, `prerelease.yml` and `release.yml` | whole-file SHA-256, byte for byte. Every job, every step, every root key below `jobs:`, every key spelling, every `uses:` reference and every line ending of each workflow is inside one digest, so there is no region a key could be written below and no spelling a key could take that this construction has to know. A `uses:` that names a local path (`./.github/actions/...`) is refused outright, in a pinned workflow, because a local action runs the directory's files and no pin covers them: there is none in the tree, and adding one means extending the pin closure over the action directory in the same change. Battery: `env: BASH_ENV` and `defaults.run.shell` appended at the end of `ci.yml` and `release.yml`, a quoted `"jobs":` shadow mapping, a quoted and a space-drifted duplicate job key, a quoted `"release-please":` duplicate, a `true:` block below `jobs:`, an action reference changed inside a pinned job, a local composite action added to a pinned workflow, a second `jobs:` mapping, `if: false` on the job and on the step, every shell spelling rounds 1-4 closed, and the CRLF, byte-order-mark and trailing-whitespace cases |
| The release path those workflows run - the transitive closure of the script paths they name: 86 files under `scripts/` and `gov-infra/`, and 37 files outside them, including `verify-release-branch.sh`, `verify-release-gates.sh`, `verify-release-publish-postcondition.sh`, `verify-release-pairing.sh`, `publish-release-assets.sh`, `run-release-please-pr.sh`, `sync-release-pr-generated.sh`, `gov-verify-rubric.sh`, the three contract runners under `contract-tests/runners/`, the ts unit-test set under `ts/test/` and the testkit and CDK examples under `examples/` | whole-file SHA-256 each. The closure is resolved from the repository root or the referencing file's directory, and a path is a finding unless it is pinned wherever it lives. The `ts/test/*.test.mjs` set is in the closure because round 7's glob membership rule reads the set `scripts/verify-ts-tests.sh` runs: every file a pinned file runs must be pinned, whether it is named or matched. Battery: the `if false` wrap of the branch-provenance call in `publish-release-assets.sh`, every shell-invoker case, `set +e`, a `bash()` definition and a re-pointed toolchain variable in the GovTheory verifier, trailing whitespace and CRLF in a pinned script, a pinned gate running a helper that names no file, a pinned gate running an out-of-root file it does not pin, an unpinned runner beside a pinned one, a pinned gate running a symbolic link into a pinned file, and the round-8 executed-path cases - `.js`, `.pl`, extensionless, `ruby`, `exec`, `.`, the command-position path, the unbraced variable directory, the glob cases and the up-walk path |
| The closure itself - a pinned file may name only files that are pinned themselves: 123 files in the closure and 5 workflows | re-derived from the pinned bytes on every run, so a workflow that gains a call site, or a pinned script that starts running another one, fails until the same change adds the pin and the closure cannot rot into a stale list. Battery: a pinned workflow naming a script nothing pins |
| Every occurrence of a guarded script name in the sweep set - every file under `.github/`, `Makefile`, and a root `package.json` when present | admitted from exactly one place: on a line byte-identical to a line a pinned workflow holds. That is additive strengthening - repeating a pinned invocation line can add a run of the gate or the guard, and it cannot weaken the step that already runs it - and it is the whole of what a file outside the pinned set may say about a guarded script. The sweep walks every file under `.github/`, so a new workflow is read rather than enumerated. There is no call site of a guarded script in the `Makefile` or in a root `package.json` today, and no local composite action, and the sweep is what keeps the first two true; that posture is stricter than "the one call site is admitted", and the accepted battery case is a *fixture* that models an admitted duplicate rather than a description of the tree. Battery: a call site added to the `Makefile` on a line that is not one of the pinned invocation lines, and, as the accepted mirror, a byte-identical pinned invocation line added to the `Makefile`, a new unguarded workflow, and a new unguarded job in a workflow no pin covers |

### What the closure derivation reads

A pinned file names the scripts it runs, and a name is read in exactly three spellings: a plain path,
from the repository root or from the referencing file's directory; the same behind a leading `./`;
and the same behind a braced variable directory (`${SCRIPT_DIR}/x.sh`), read as a directory relative
to the referencing file, which is what that variable means in every script here. Everything else fails
closed: an unbraced variable, a quoted segment, a command substitution, an absolute path and a `~` are
refused rather than skipped, each a finding on its own whether or not a line runs it, because a
spelling this guard cannot canonicalise is a script it cannot vouch for. Rounds 1-6 read the first two
of those spellings and skipped every other one, which is how `bash "$SCRIPT_DIR/new-helper.sh"`,
`bash scripts/"new"-helper.sh` and `bash "$GITHUB_WORKSPACE/scripts/new-helper.sh"` each ran unpinned
code past a PASS. The admitted side of the spelling table is witnessed by names the pinned tree
itself writes, so a spelling nothing writes fails the battery rather than quietly shrinking what the
derivation is asked to read, and each refused spelling has an attack row.

A name that resolves to no file is read as a name, and it is a finding when the line it is written on
runs it. The reading is deliberately coarse - a line that reaches an executor before the name reads as
executed whether or not it runs that name - because the direction of the error is the safe one.

The executor spellings are `bash`, `sh`, `zsh`, `dash`, `ksh`, `source`, `.`, `env`, `command`,
`xargs`, `nohup`, `exec`, `python`, `python3`, `python2`, `node`, `nodejs`, `ruby`, `perl`, `php`,
`deno`, `bun`, `make`, `find`, `subprocess` and `child_process`, enumerated once in the guard and only
there, and the guard asserts that this sentence is that list: an executor the prose names and the code
does not read - `.` was one, for six rounds - is a spelling nothing refuses and nothing reads. The set
is closed: `ruby`, `perl`, `php`, `exec` and the pipe form `... | xargs bash` each name a file the
guard now reads, and an unrecognized command whose non-option argument is a glob is refused rather than
skipped, because there is no way to say what an unknown command does with what the glob expands to.

### The executed-path rule: the suffix comes off

The read-or-run rule above reads a name with one of six suffixes wherever it sits in a pinned file.
That rule alone left the hole this section closes. `node scripts/evil-helper.js` and
`perl scripts/evil.pl` name no suffix that list holds, so nothing read them: the helper could be added
with the documented two-place edit and then edited forever, because no pin ever named it again. Live
today, `scripts/invoke-release-please-pr.sh` runs `scripts/invoke-release-please-pr.mjs` (pinned) and
that launcher loads the release-please module out of a `node_modules/` directory the pinned stager
builds at run time - dependency code, and the case the carve-out below states.

The executed-path rule replaces the suffix list where a file is *run*. A path-like token written where
a command runs it must resolve to a pinned file, **whatever its suffix, including no extension at all**:
the token a command runs (the first non-option argument of an executor), the argument of a launcher
(whose own operand is the next command, which is what `exec <path>` is), a path written as the command
itself, and the items of a `for ... in ...` list. A path-like token is one that holds a directory
component. An unbraced variable, a quoted segment, a command substitution, an absolute path and a `~`
are refused at these sites too, exactly as they are at the read-or-run rule.

Two readings bound the rule, and both are stated rather than implied. A *command line* is a line that
starts at the left margin or is the value of a `run:` key; an indented line that is neither is a
continuation, an argument list, a YAML value or a heredoc body, and its first word is a name rather
than a command. That is why `"${REPO_ROOT}/go.mod"` on a line of an array literal and
`py/pyproject.toml` under a `cache-dependency-path:` block are not read as commands, and why a heredoc
body - `python3 - <<'PY'`, `cat <<'EOF'` - is read as the language it is. A command's arguments stop
at its first operand, so `python3 tool.py "ts/dist/index.d.ts"` reads the tool and leaves the data it
is handed alone; `make`, `find`, `subprocess` and `child_process` name a makefile selector, a search
root and a command line rather than a file to run, so the rule does not read their argument, and `make`
keeps the selector rule stated below.

A name stored in a variable and expanded later - `"${files[@]}"`, `"$f"` - is read as a name, not as a
file, at every site in this file. That is the rule's one limit and it is deliberate: a variable's value
is not in the bytes the guard reads, and a guard that guessed it would be guessing. What the limit
leaves open is a name materialized at run time and run without ever being written down, and that is
stated rather than glossed: `printf '%s\n' some.js | xargs bash` names its file as data in another
command, and a name no pinned file writes is a name no pin can describe.

### Globs, and the one the tree runs

A glob is a name with no file in it until the shell expands it. Round 7 read a glob as a name (a token
that is part of a glob was not read at all), which let a pinned file run whatever a glob matched while
pinning nothing: add `for f in examples/testkit/*.mjs; do node "$f"; done` to a pinned gate, plant an
unpinned `examples/testkit/evil2.mjs`, update the pin, and the guard was green.

A glob in a running position is now a finding unless the pins describe the set it matches. The guard
expands the glob the way the shell would - from the repository root and from the referencing file's
directory, with an admitted variable directory stripped - and requires every file it matches to be
pinned, re-derived on every run. A glob that matches nothing is a finding too, because a set that names
no file is a set nothing describes; a glob whose matches are all pinned is the set the guard accepts,
which is how the `ts/test/*.test.mjs` line the tree runs is admitted and how the plant is caught.

An occurrence sweep matches a guarded script's *name*, so it does not see a glob, and this is the
sweep's one limit, stated rather than glossed: `printf '' > scripts/verify-release-pa*` names no
guarded script. In a pinned file that shape is a digest finding anyway, because the file's bytes
changed, and the battery carries it. In a file no pin covers it is not seen, and it is harmless there:
an unpinned file runs on another runner or in another workflow, so it cannot reach the workspace a
pinned step runs in, while the five workflows - the files where the shape would matter - are pinned
whole.

### The one carve-out: dependency code

A path under a `node_modules/` directory, a `.venv/` or `venv/` directory, or `gov-infra/.tools/` is
**dependency or tool code**, and the executed-path rule reads it as such rather than silently not
reading it. The reason it is out of scope is not that it is unimportant; it is that it is not in this
repository. All three directories are git-ignored, so no commit can change a byte of any of them, and
each is materialised at run time by an installer a pinned file names: `stage-release-please-package.sh`
pins the exact version `release-please@17.1.3` and installs with `--ignore-scripts`, so no dependency
lifecycle script runs, and its assertions - the version pin, the credential-free boundary - are held
by `verify-release-please-token-safety.sh`, which is pinned like everything else on the release path;
the two venvs are built by pinned scripts from `requirements-build.txt` and `requirements-lint.txt`,
whose versions are exact pins; `gov-infra/.tools` is built by the GovTheory verifier from exact
version pins. The limit is stated rather than implied: the npm staging runs with `--no-package-lock`,
so the transitive bytes under `node_modules/` are registry-resolved and not lockfile-pinned, and this
guard does not claim otherwise. A pinned file that runs repo code under one of those directories is a
finding; the carve-out is exactly the directory, and the battery carries both directions.

A name that resolves to no file is read as a name, and it is a finding when the line it is written on
runs it. A name that resolves is a finding unless it is pinned, and where it lives does not enter into
it: a pinned file may name only files that are pinned, so the 37 files outside `scripts/` and
`gov-infra/` that the closure names are pinned too. The derivation does not tell a read from a run,
because a byte scanner cannot, and that is the honest reading rather than a guess that a file which is
only read is harmless: a name is pinned whether the site reads it or runs it.

A name that resolves through a symbolic link is a finding, because the bytes that execute are the
linked bytes, and no pinned file may itself be a link for the same reason. `make -C <dir>` and
`make -f <file>` name the makefile the selector reads, and that makefile must be pinned - or already
be a file the occurrence sweep reads - like anything else, so `make -C scripts` against an unpinned
`scripts/Makefile` is a finding. A bare `make` names the makefile of the directory it runs in, which
a byte scanner cannot follow through a `cd`, so the repository root's makefile and the referencing
file's own directory are both read when they exist.

The admitted spellings are witnessed by names the pinned tree itself writes, so a spelling nothing
writes fails the battery rather than quietly shrinking what the derivation is asked to read, and each
refused spelling has an attack row. A witness is a *code* witness: the witness check reads each file
with its comments stripped, because round 7 satisfied the up-walk row with a shellcheck directive -
prose about a spelling - while the code below it wrote the braced form. The up-walk spelling is no
longer in the witness table at all, because nothing in the pinned tree writes `../x.sh` as a path it
resolves; what remains is the read, and the battery proves the read with an attack row that walks up
to an unpinned file. An admitted spelling nothing writes is surface, so it is dropped rather than
witnessed by a comment.

What is **not** pinned anywhere in this repository, said plainly - it is one file:

| File | Why it is not pinned |
| --- | --- |
| `scripts/verify-release-workflows.sh` | This guard. A file cannot pin its own bytes: a weakened copy would carry the weakened pin with it, so a self-pin would prove nothing. Any weakening of this file is caught by review and by nothing else. A pinned file that names this guard - every release gate does - is admitted, because there is nothing here to pin. |

That residual is the one this construction cannot close, and no count or tripwire here should be read
as enforcement of it: a weakened guard asserts its own weakened counts, so the number of pins and the
size of the battery prove what the guard does only for a guard that is honest. It is worth naming the
cheap shapes a reviewer has to look for, and being exact about which of them the repository catches -
round 7's table claimed every row was "a single-file edit that passes everything in this repository",
which is true of two of the four and false of the two that gut a finding function:

| Shape | What it buys, and whether anything catches it |
| --- | --- |
| Deleting a pin - the `verify-release-please-token-safety.sh` root, the two `gov-infra/` verifier pins, or any entry of the closure - **plus** the matching count in this document | the deleted file runs unpinned, and the count in the sentence above still validates because it is read out of the same weakened artifact. Review-only: the battery cannot see a pin that is missing rather than wrong |
| Dropping `spelling_witness_findings` from `guarded_surface_findings`, or narrowing the derivation - removing the refused-spelling branch, taking the suffix boundary back off, or dropping the executed-path rule, the glob membership rule or the local-action rule | the admitted spellings are no longer witnessed and a whole family of names stops being read. Review-only, because the battery is run by the same file |
| Gutting `digest_findings`, `closure_findings`, `sweep_findings` or `executed_path_findings` while leaving the tuples and the battery in place | **not** review-only, and the round-7 claim that it passes everything was wrong. The battery runs in CI - `ci.yml`'s release/security step, through `verify-release-gates.sh`, which is where `--self-test` runs - so emptying one of these functions fails loudly on the first case that expects its class. It is a shape a reviewer should still look for, because a *narrowed* function - one that finds most of what it should - can keep every battery case green |
| Narrowing `CLOSURE_ROOTS` to `("scripts/",)` | nothing. The roots name the release path in the finding messages and in this document and gate no decision, so narrowing them is cosmetic. It was a real shape in round 6, when a path outside them was skipped; it is not one now, and it is listed here so that a reviewer who remembers it does not stop looking at the rows above |

The other unpinned file is the root `Makefile`. The sweep reads it for a guarded script name, and it
has **no call site today** - not an admitted one, none at all - which is stricter than the sentence
round 7 carried here; an edit to a `make` target that runs code naming no guarded script is caught by
review, not by a pin. The accepted battery case is the mirror image of that rule and not a description
of the tree: it is a fixture that adds a byte-identical pinned invocation line to the `Makefile`, so
the *admission* is exercised even though nothing in the tree needs it.

The battery cannot close this residual either: a case that weakens the guard file is admitted by
construction, because the guard file is the boundary the battery is built on. What the battery
asserts is the opposite direction - that the legitimate wiring is accepted before any attack is
tried - so a construction that over-blocks fails as loudly as one that starts missing.

Round 5 disclosed three files here, and two of them are in the interior now: `ci.yml` invokes both
`scripts/verify-ci-rubric-enforced.sh` and `scripts/verify-release-pairing.sh`, so both are in the
release-path closure and an edit to either is a digest finding like any other. The battery carries that
as two attack cases - the accepted cases that used to assert those two boundaries - and one accepted
case remains for the boundary that is left, so the disclosed file cannot quietly become a claim the
guard covers.

Round 4's and round 5's accepted tables are gone, and the claims they carried with them. Each entry was
admitted by the freedom to add a statement to a pinned run body, an inert section to a workflow, or a
tolerance for whitespace and line endings. Every one of them either changes the bytes of a pinned file
or names a guarded script outside the pins: a trailing comment on the invocation line, a `true` line
after it, a quoted `--self-test`, an unrelated `set +e` / `set -e` pair inside the GovTheory verifier,
an `x-` section holding a weakened invocation, an unrelated verifier added to a pinned step, trailing
whitespace on a pinned line, and CRLF line endings. All of them fail closed as attack cases now, and the
workflow for any of them is the documented two-place edit - change the file and the pin together -
rather than an admission.

Every row of the tables above has a battery case behind it in `--self-test`, and a row with no case is
removed rather than kept. The two pin rows are carried by the shapes that add or edit a byte of a
pinned file - a statement or a key added anywhere in a workflow, a root key appended below `jobs:`, a
key spelling YAML resolves to a pinned key, an action reference changed inside a pinned job, a whole
trailing job that absorbs an append, an edit to any file in the release-path closure - and the closure
row by a pinned workflow naming a script nothing pins, by a pinned gate running a helper that names no
file, by an unpinned runner beside a pinned one, by a pinned gate running an out-of-root file and by a
pinned gate running a symbolic link into a pinned file. The executed-path row is carried by the
suffix-free family the round-7 review opened: a `.js` helper, a `.pl` helper, an extensionless helper,
`ruby`, `exec`, `.`, a path written as the command itself, an unbraced variable directory, a glob that
matches nothing, a glob whose matched set holds a plant, an unrecognized command run against a glob, an
up-walk path to an unpinned file, and a local `uses:` in a pinned workflow. The spelling rows are
carried by one attack case per refused spelling - unbraced variable, quoted segment, `$GITHUB_WORKSPACE`,
command substitution, absolute path, home directory - and by a witness assertion per admitted spelling,
which fails if nothing in the tree writes one *in code*; the row that moves a witness into a comment is
there to prove that direction. The make row is carried by `make -C scripts` against a makefile pinned by
nothing, and the sweep row by a call site added to the `Makefile` on a line that is not a pinned
invocation line.

The accepted table holds the mirror image, so a construction that over-blocks fails the self-test as
loudly as one that starts missing: the legitimate wiring at HEAD (asserted before any attack is tried),
a byte-identical pinned invocation line added to the `Makefile`, a new unguarded workflow, a new
unguarded job in a workflow no pin covers, and the one disclosed boundary above. Two further accepted
rows are edits to a *pinned* file, and the harness applies the pin update with them, because that is
the documented two-place edit: a pinned gate that runs a `node_modules/` dependency path (the carve-out
above) and a pinned gate that runs a glob whose every match is pinned. Every admitted shape is
additive: none of them can change a byte of a pinned file without the pin update beside it, and none
can stop a pinned step from running.

The guard's own invocations go through the same pins - the release/security step in `ci.yml`, the
release preflights in `prerelease.yml` and `release.yml`, `scripts/verify-release-gates.sh` and
`gov-infra/verifiers/gov-verify-rubric.sh` - so weakening a call of the guard fails as loudly as
weakening a call of the gate it guards. The YAML forms the runner would resolve differently from a
literal reading - a `<<:` merge key, a second document in one workflow file, a YAML alias (`*name`,
which re-points a value at a node defined elsewhere), a quoted or space-drifted duplicate key, and a
`true:` block that YAML 1.1 reads as the same key as `on:` - are all ordinary byte changes here,
because every file that holds one is pinned whole. None of them has to be classified, and none of them
can be written past.

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
