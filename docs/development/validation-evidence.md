# Proportionate release validation

AppTheory keeps the same required checks, signing rules and release discipline,
but executes expensive proof once per real input set and per tested environment
instead of once per event. The operator authorized this execution-policy change
on 2026-11-12 and corrected it again in rework round 2 after rejecting a model
that still re-ran the same environment on every release leg. The correction
changes **where, how often, and under which environment label** proof runs. It
does not remove a check, lower a threshold, weaken a gate, alter branch
protection or accept a self-declared result.

This document is the human half of the policy. `scripts/evidence/validation-gates.json`
is the machine half; `scripts/evidence/check-policy.py`, `cmd/ci-guard`, and
`scripts/verify-runtime-floor-claims.sh` keep them aligned with the workflows and
the release-please configuration.

## Trust model

- An implementer runs the approved command set once on the final inputs, under
  the governed toolchain of a tracked proof profile, and commits sanitized
  evidence records. Independent reviewers inspect the source, the recorded
  results, trace/log digests and references, and run targeted probes. They do
  not re-run the full harness.
- CI is an **evidence verifier**, not the environment under test for portable
  source, packaging and journey claims. It verifies that the recorded proof
  applies to the exact candidate inputs and to the tracked profile. It never
  treats a record as an authenticated verdict and never executes a command named
  by a record.
- The accepted provenance is ordinary cooperating implementer and reviewer
  provenance. There is no signing of test execution, no remote attestation and
  no persistent proof service.
- A pull request whose head repository is not this repository always executes
  the real command set. Evidence records carried by untrusted content gain
  nothing, and the pull-request lane keeps read-only credentials.
- Paired approval of the candidate remains the Factory review gate.

## Proof profiles: one claim, one environment, one proof

A **proof profile** is a tracked declaration of a supported environment: the Go
repository pin, the Node major, the Python major.minor, and the producing
OS/arch. The collector probes the real versions it runs under and refuses to
record a profile the live host does not satisfy. Verification compares the
recorded environment with the tracked profile declaration, never with the
verifier runner.

| Profile | Go | Node | Python | Producing host | Used by |
| --- | --- | --- | --- | --- | --- |
| `default` | `go1.27.4` | 24 | 3.14 | darwin/arm64 (approved producing host) | every product gate, packaging and journey proof |
| `floor-node22` | `go1.27.4` | 22 | 3.12 | linux/x64 (intended CI floor) | `ts`, `cdk-go-drift` |
| `floor-py3.12` | `go1.27.4` | 24 | 3.12 | linux/x64 | `py` |
| `floor-node22-py3.12` | `go1.27.4` | 22 | 3.12 | linux/x64 | `contract-tests` |
| `floor-node22-py3.14` | `go1.27.4` | 22 | 3.14 | linux/x64 | `contract-tests` |
| `floor-node24-py3.12` | `go1.27.4` | 24 | 3.12 | linux/x64 | `contract-tests` |

A record is bound to exactly one profile (`gov-infra/evidence/proportionate/<gate>/<profile>.json`)
and stores the raw probed environment it ran in. A profile proves a claim once
for a given input set; every later release event for the same inputs reuses it,
so an expensive command is executed once per profile per input set, zero repeats.
A changed runtime floor or a changed input invalidates only that profile. Node 24
never proves Node 22: a floor profile must be produced under that floor.

### The four claim kinds, kept distinct

1. **Portable source/functional proof** (`go`, `unit`, `ts`, `py`,
   `contract-tests`, `cdk-go-drift`, `rubric`, `security-refresh`). It binds only
   the toolchains its commands use. The record discloses the host it ran on, but
   the claim is about the source and the toolchain version, so a macOS-produced
   record verifies on GitHub Ubuntu and no second full harness is needed merely
   to change the label to Linux.
2. **Local journey proof** (`examples-local`) and **build reproducibility on the
   producing host** (`deterministic-builds`). These claims are platform-bound:
   the profile must match the declared OS/arch. CI verifies the claim for the
   approved producing host and says so; it does not claim Linux execution from a
   macOS proof.
3. **Floor compatibility proof.** One profile per tested environment. The
   dedicated latest/latest job set uses `default`; each lower-floor matrix cell
   names its own profile. A cell that shares a claim with an already-proven
   profile verifies instead of re-executing.
4. **Linux release artifact construction.** The publisher builds real release
   assets on Linux once at release. It is a separately named artifact-production
   operation, not a repeat of the source rubric, contract corpus or examples
   harness, and it is never replaced by a profile record.

### Collecting a profile

```bash
# Show the real versions this host would record.
python3 scripts/evidence/validation_evidence.py probe

# Default producing-host profile (go.mod selects the Go pin).
python3 -m pip install -r py/requirements-build.txt   # once, under Python 3.14
scripts/evidence/collect.sh --all --profile default

# One floor profile, under the governed floor toolchain.
scripts/evidence/collect.sh --gate ts --profile floor-node22
scripts/evidence/collect.sh --gate py --profile floor-py3.12
scripts/evidence/collect.sh --gate contract-tests --profile floor-node22-py3.12
```

Go is governed by the repository pin (`go.mod` / `GOTOOLCHAIN`). Node and Python
are governed by the selected interpreter; the intended local governor is the
`tc-toolchain` layer used elsewhere in the repository. If a profile cannot be
produced on the current host (for example Node 22 is not installed), collection
fails closed with the exact mismatch. The CI floor job for that profile then
executes once, uploads its sanitized record, and that single record makes every
later leg reuse it — it is not re-executed on each event. A profile with no
record is never treated as proven.

A matching record is reused on GitHub Ubuntu because verification never consults
the runner's own Node/Python/OS for a portable claim: it checks the record
against the tracked profile. The record keeps the raw producer environment so
reviewers see the truth, and a record whose environment does not match its
declared profile is rejected.

## Incremental collection

`scripts/evidence/collect.sh` is incremental by default. It inspects the
existing gate records for the requested profile first, then schedules only
missing, failed, stale or affected work:

```bash
# Enumerate the required coverage; execute only what is missing or affected.
scripts/evidence/collect.sh --all --profile default

# Re-run one gate only when its declared input scope changed.
scripts/evidence/collect.sh --gate go --profile default

# Show the schedule without executing anything.
scripts/evidence/collect.sh --all --profile default --dry-run

# Explicit override: ignore applicable records and execute. Never the default.
scripts/evidence/collect.sh --all --profile default --force

# Bound parallelism lower than the tracked conservative default.
scripts/evidence/collect.sh --all --profile default --jobs 1
```

`--all` enumerates the required coverage for the selected profile. It does not
unconditionally re-execute every command. A second run over unchanged inputs
executes **zero commands**, including across interrupted sessions when completed
records remain applicable. `--force` is the only way to re-execute applicable
proof, and it is never the documented default.

Each gate records its own **declared input scope**. Product gates ignore
documentation, `gov-infra/`, workflow and tooling changes; the full rubric
includes them because its docs and governance checks read them. A changed input
inside a gate's scope invalidates that gate only. A file that matches no product
scope and no declared non-product path is an unknown input: every product gate
falls back to broad execution and the verifier refuses to reuse a record.

## Bounded parallel scheduler

Independent gates overlap; conflicting filesystem/build-output/Docker work
serializes through explicit tracked resource groups. A gate may declare several
groups (a command that writes the repository while running Docker holds both).

| Gate | Resource groups | Depends on | Input scope |
| --- | --- | --- | --- |
| `go` | `cpu` | — | Go modules, contract runners, examples |
| `unit` | `cpu`, `repo-write` | `go` | Go unit selection, TypeScript tests, Python tests |
| `ts` | `repo-write` | `deterministic-builds` | `ts/`, dist drift and pack scripts |
| `py` | `repo-write` | `deterministic-builds` | `py/`, Python build script |
| `contract-tests` | `cpu`, `repo-write` | — | fixtures, API snapshots, runtime surfaces |
| `cdk-go-drift` | `repo-write` | — | `cdk/`, `cdk-go/`, generation scripts |
| `deterministic-builds` | `cpu`, `repo-write` | — | packaging inputs and scripts |
| `examples-local` | `docker`, `repo-write` | — | examples, local harness, synth proof |
| `security-refresh` | `network` | — | dependency manifests and scan script |
| `rubric` | `repo-write` | `go`, `unit`, `contract-tests`, `cdk-go-drift`, `deterministic-builds` | all source, docs and governance inputs |

The tracked default is two workers. `cpu` admits two Go-family jobs; every
filesystem/build writer shares the single `repo-write` resource group, so the
examples harness, package scripts and jsii builds never write the same outputs
concurrently. Docker and network work can overlap with CPU work. Resource
serialization is the prevention mechanism for shared outputs; input-change
detection is a separate taint check, not a substitute for it.

Completed records are written atomically as each gate finishes. An interrupted
run keeps its completed records, publishes nothing for an incomplete gate and
returns a non-zero status. A restart executes only the incomplete or changed
work. Cancellation terminates every owned process group; the collector never
returns green while a child failed or leaves an owned writer running.

When a prerequisite fails or its gate is cancelled, its dependents are marked
`blocked` and are **not executed** through any fallback in that same collection.
Independent gates that already completed keep their records, and the run returns
a truthful non-zero aggregate. The next explicit run retries only the failed or
missing work.

## Composition instead of duplicated re-execution

There is exactly one dedup mechanism: composition. A gate whose coverage another
gate already produced declares `composedFrom` and exports
`APPTHEORY_EVIDENCE_REUSE`. The leaf entry point calls
`scripts/evidence/reuse-if-recorded.sh`, which verifies the named record for the
current profile against the exact candidate inputs and never executes a recorded
command. A missing, stale, mismatched or failed record falls through to the real
command, so composition can reduce repeated work but can never fabricate a pass.

The standalone `ts` and `py` packaging gates declare
`composedFrom: deterministic-builds`: those scripts run inside both determinism
passes, so when that record applies the standalone gate verifies it instead of
packing a third and fourth time. A profile or toolchain mismatch falls through to
the real packaging command.

The CDK TypeScript pack and Python build appear in the release-gates step as
`scripts/verify-cdk-packaging.sh`. At rubric nesting the wrapper declares that
the two deterministic-build passes own those two package builds; the composed
script re-checks that the verifier still runs `verify-builds.sh` and that
`verify-builds.sh` still runs both packages, then builds nothing. A forced
collection or any direct caller builds both packages for real. The control test
counts the nested invocations.

The consumed records are written into the consuming record's `consumed` list with
their scope digests and timestamps. That is the coverage attribution: a green
rubric means either the composed record verified or the real check ran inside the
rubric. Verification of a composed record also re-verifies every consumed
dependency record for the same profile against the current inputs; deleting or
changing one makes the composed record inapplicable instead of leaving a stale
green. The two-pass deterministic build unsets the reuse environment in its inner
passes, so a nested leaf can never turn the determinism proof into a no-op.

## Input identity

Inputs are enumerated from `git ls-files --cached --others --exclude-standard`,
so tracked and untracked-but-not-ignored files are both covered, and the actual
working-tree bytes and modes are hashed rather than the index. Missing inputs
fail closed. The enumerator partitions every file into exactly one projection:

- **source inputs** — everything except the evidence directory and the
  release-only set;
- **release-only inputs** — the explicit version-coupled and regenerated paths
  in the registry (`VERSION`, both manifests, `CHANGELOG.md`, package manifests
  and lockfiles, `cdk/.jsii`, `cdk/lib/**`, `cdk-go/**`, example CDK lockfiles);
- the dedicated evidence directory itself is the only evidence-content
  exclusion.

The source digest identifies ordinary proof. It is content-addressed, so the
same tree verifies across commit SHAs, branch names and evidence-only commits.
Each gate stores a scope digest computed over its declared inputs. Release-only
files inside that scope are normalized by substituting the recorded `VERSION`
literal, so a pure version transformation stays applicable while any other edit
in the same path still invalidates the gate. A source or documentation edit
outside a product gate's scope does not invalidate that product proof.

`release-delta` performs the narrow regeneration and packaging smoke once per
changed generated artifact set. It deliberately does not run the rubric,
contract corpus, examples harness or language test suites, and it executes on the
current event rather than reusing a record (its state is the generated artifact
set itself).

## Record schema

Records live at `gov-infra/evidence/proportionate/<gate>/<profile>.json` and are
tracked. Local logs live under `gov-infra/evidence/proportionate/local/` and stay
ignored; the record carries only their digest and a reference.

```json
{
  "schemaVersion": 1,
  "gate": "rubric",
  "kind": "source",
  "profile": "default",
  "verdict": "PASS",
  "reason": "",
  "recordedAt": "2026-11-12T18:00:00Z",
  "environment": {
    "go": "go1.27.4",
    "node": "v24.21.0",
    "python": "3.14.3",
    "platform": {"os": "darwin", "arch": "arm64"}
  },
  "scope": {
    "version": 1,
    "digest": "sha256:…",
    "fileCount": 3118,
    "paths": ["**"]
  },
  "source": {"digest": "sha256:…", "fileCount": 3118},
  "releaseOnly": {
    "digest": "sha256:…",
    "normalizedDigest": "sha256:…",
    "fileCount": 457,
    "version": "7.1.0"
  },
  "commands": [
    {
      "id": "rubric",
      "argv": ["make", "rubric"],
      "exitCode": 0,
      "startedAt": "2026-11-12T17:10:00Z",
      "finishedAt": "2026-11-12T17:55:00Z",
      "durationSeconds": 2700.0,
      "logDigest": "sha256:…",
      "logRef": "gov-infra/evidence/proportionate/local/rubric-rubric-….log",
      "inputsDigest": "sha256:…",
      "executed": true,
      "reused": false
    }
  ],
  "consumed": [
    {"gate": "go", "digest": "sha256:…", "recordedAt": "2026-11-12T17:10:00Z"}
  ],
  "reviews": [{"ref": "factory-review-…", "kind": "review-reference"}],
  "producer": {"tool": "scripts/evidence/validation_evidence.py", "registry": "validation-gates.json"}
}
```

A dependency scan adds `dependency.digest` and `scan.scannedAt` plus
`scan.maxAgeSeconds`. The tracked default is 86 400 seconds. Future timestamps,
invalid timestamps and scans older than the bound are rejected, and a stale scan
refreshes only the dependency scan.

Commands, exit codes, timestamps, log digests, per-command `inputsDigest` values,
the profile and the environment are validated strictly. Records with unknown
keys, unapproved commands, an unsupported profile, non-zero exits, malformed
digests or a `FAIL` verdict are never reused. The collector retains a failed
record honestly and exits non-zero.

Records written before the scope-binding change lack `scope` and
`commands[].inputsDigest`. They are historical provenance, not reusable proof:
the verifier reports them as unsupported and the collector recollects the
affected gate. It does not edit an old record into a new pass.

## Workflow

```bash
# Enumerate every approved gate for the default profile.
scripts/evidence/collect.sh --all --profile default

# Or only the gates affected by a follow-up source fix.
scripts/evidence/collect.sh --gate go --gate ts --profile default

# Verify without executing anything named by the record.
scripts/evidence/verify.sh --gate rubric --profile default

# Reuse applicable proof, otherwise execute the approved commands (CI entry point).
scripts/evidence/verify-or-execute.sh --gate rubric --profile default

# Add reviewer references after review without invalidating input identity.
python3 scripts/evidence/validation_evidence.py finalize --gate rubric --profile default --review-ref factory-review-1234
```

Review references are recorded after the reviewers can see the candidate, so
finalization never demands future review IDs. Adding references or any other
evidence-only file does not change the scope digest. Signing applies to the
evidence-only commit like any other commit.

Collection requires a clean worktree outside the evidence directory. Commit the
source first, collect, then commit the records (signed). A source fix after
review invalidates only the affected gates and profiles; recollect those, or run
`--all --profile <id>` and let the scheduler decide.

## Applicability summary in CI

Every evidence-aware job prints one unambiguous line and a job-summary entry:

- `gate <id> (profile <id>): evidence-verified (no command executed in this run)`; or
- `gate <id> (profile <id>): executing (<reason>)` followed by the real approved command.

The staging required context keeps its name, `Rubric (full gate set)`. A green
state means the recorded proof was verified for the candidate inputs and the
tracked profile, not that the command was executed in that run. When a committed
record does not apply, the gate executes its real command; that is the
missing-proof fallback, not a silent pass, and the produced sanitized record is
uploaded so one commit can make later legs reuse it.

The PR lane runs workflow code from the candidate. That is acceptable because
all PR-lane permissions are read-only, the verifier never executes record
contents, and paired review inspects the workflow and evidence diff. Privileged
release operations run only from protected branches.

## Execution matrix

| Leg | Event | Old behavior | New behavior |
| --- | --- | --- | --- |
| `pr-staging` | pull request → staging | every job executes on the merge ref | required product jobs reuse applicable evidence for their tracked profile; untrusted or unmatched inputs execute |
| `push-staging` | merge push → staging | every job re-executes on the merged tree | product and floor jobs reuse each profile's proof; release/security gates execute cheaply |
| `pr-staging-premain` | staging → premain promotion PR | CI product set plus promotion readiness/eligibility | promotion readiness/eligibility plus evidenced product checks per profile; no source rerun |
| `push-premain` | promotion merge push → premain | CI product set re-executes, then release-please generates the RC PR | CI reuses each profile's evidence; release-please generation and artifact sync run |
| `release-pr-premain` | generated RC release PR | dispatched CI re-executes the product suite on generated artifacts | release-delta packaging/drift smoke once; product and floor jobs verify their profile records |
| `release-merge-premain` | RC merge/publish on premain | CI product set re-executes, then the publisher builds assets again | product checks verify profile evidence; signatures and version state run; publisher builds real Linux assets once |
| `pr-premain-main` | premain → main promotion PR | CI product set plus promotion readiness/eligibility | promotion readiness/eligibility plus evidenced product checks per profile; no source rerun |
| `push-main` | promotion merge push → main | CI product set re-executes, then release-please generates the stable PR | CI reuses each profile's evidence; release-please generation and artifact sync run |
| `release-pr-main` | generated stable release PR | dispatched CI re-executes the product suite on generated artifacts | release-delta packaging/drift smoke once; product and floor jobs verify their profile records |
| `release-merge-main` | stable merge/publish on main | CI product set re-executes, then the publisher builds assets again | product checks verify profile evidence; signatures and version state run; publisher builds real Linux assets once |
| `backmerge-main-staging` | main → staging back-merge PR | full rubric, builds, examples and matrix re-execute | evidenced pure version-transformation reuse per profile; a real source delta executes the affected gates |

The lower-floor matrix maps each cell to explicit profiles:

| Cell (Node / Python) | `ts` profile | `py` profile | `contract-tests` profile |
| --- | --- | --- | --- |
| 22 / 3.12 | `floor-node22` | `floor-py3.12` | `floor-node22-py3.12` |
| 22 / 3.14 | `floor-node22` | `default` (py 3.14) | `floor-node22-py3.14` |
| 24 / 3.12 | `default` (Node 24) | `floor-py3.12` | `floor-node24-py3.12` |

The CDK Node 22 floor uses `floor-node22`. `ci-guard` resolves every profile
reference (literal or matrix-driven) against the tracked declarations and the
job's explicit matrix cells, so a cell cannot name an undeclared profile or fall
back to forced execution. `verify-runtime-floor-claims.sh` keeps the floor
coverage and the workflow in agreement.

## Signature range trust

`scripts/verify-release-branch-signatures.sh` scans the new commits of the
current event, bounded by that event's own accepted base:

- pull request: the base commit (`pull_request.base.sha`) → head;
- push: the `before` commit → head;
- dispatched generated release PR: the accepted protected branch it merges into
  (`origin/premain` or `origin/main`) → the dispatched head;
- manual audit: an explicit `--range`.

The base must be an ancestor of the head, both endpoints must resolve locally,
and a missing or zero base fails closed. No ancestor `v*` tag is treated as proof
of published history, no unrelated ref histories are scanned, and already-seen
commit SHAs are not verified twice across overlapping ranges. There is no remote
write, tag mutation or branch-protection change in this gate.

## Known limits

- Evidence proves the inputs, the tracked profile and the cooperating
  implementation, not a cryptographic attestation of execution.
- A floor profile that cannot be produced on the implementer's host stays
  unproven until its one real execution is captured; until then that CI job
  executes and fails closed on errors. It is not silently substituted with a
  different floor's proof.
- The generated release transformation is bounded by the explicit release-only
  path set, version-normalized equality and `release-delta` regeneration
  equality. A change outside that set is a source change and requires the
  affected validation.
- The scheduler's per-gate input scopes are conservative declarations. A new
  file outside every declared product scope is treated as unknown and forces
  broad execution; it is never silently inherited as green.
- Publish remains real-path evidence: local and PR proof does not prove GitHub
  publication, and Linux release artifact construction is its own operation.
