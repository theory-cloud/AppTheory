# Proportionate release validation

AppTheory keeps the same required checks, signing rules and release discipline,
but executes expensive proof once per real input set instead of once per event.
The operator authorized this execution-policy change on 2026-11-12 and corrected
the collector default on the same date after rejecting a serial all-gates run.
The correction changes **where and how often** proof runs. It does not remove a
check, lower a threshold, weaken a gate, alter branch protection or accept a
self-declared result.

This document is the human half of the policy. `scripts/evidence/validation-gates.json`
is the machine half; `scripts/evidence/check-policy.py` keeps them aligned with
the release-please configuration.

## Trust model

- An implementer runs the approved command set once on the final inputs and
  commits sanitized evidence records. Independent reviewers inspect the source,
  the recorded results, trace/log digests and references, and run targeted
  probes. They do not re-run the full harness.
- CI verifies that the recorded proof applies to the exact candidate inputs. It
  never treats a record as an authenticated verdict and never executes a command
  named by a record.
- The accepted provenance is ordinary cooperating implementer and reviewer
  provenance. There is no signing of test execution, no remote attestation and
  no persistent proof service.
- A pull request whose head repository is not this repository always executes
  the real command set. Evidence records carried by untrusted content gain
  nothing, and the pull-request lane keeps read-only credentials.
- Paired approval of the candidate remains the Factory review gate.

## Incremental collection

`scripts/evidence/collect.sh` is incremental by default. It inspects the
existing gate records first, then schedules only missing, failed, stale or
affected work:

```bash
# Enumerate the required coverage; execute only what is missing or affected.
scripts/evidence/collect.sh --all

# Re-run one gate only when its declared input scope changed.
scripts/evidence/collect.sh --gate go

# Show the schedule without executing anything.
scripts/evidence/collect.sh --all --dry-run

# Explicit override: ignore applicable records and execute. Never the default.
scripts/evidence/collect.sh --all --force

# Bound parallelism lower than the tracked conservative default.
scripts/evidence/collect.sh --all --jobs 1
```

`--all` enumerates the required coverage. It does not unconditionally
re-execute every command. A second run over unchanged inputs executes **zero
commands**, including across interrupted sessions when completed records remain
applicable. `--force` is the only way to re-execute applicable proof, and it is
never the documented default. The second unchanged run executes zero commands:
the collector reports `executed=0` and writes no local command log.

Each gate records its own **declared input scope**. Product gates ignore
documentation, `gov-infra/`, workflow and tooling changes; the full rubric
includes them because its docs and governance checks read them. A changed input
inside a gate's scope invalidates that gate only. A file that matches no product
scope and no declared non-product path is an unknown input: every product gate
falls back to broad execution and the verifier refuses to reuse a record.

## Bounded parallel scheduler

Independent gates overlap; conflicting filesystem/build-output/Docker work
serializes through explicit tracked resource groups:

| Gate | Resource group | Depends on | Input scope |
| --- | --- | --- | --- |
| `go` | `cpu` | — | Go modules, contract runners, examples |
| `unit` | `repo-write` | `go` | Go unit selection, TypeScript tests, Python tests |
| `ts` | `repo-write` | — | `ts/`, dist drift and pack scripts |
| `py` | `repo-write` | — | `py/`, Python build script |
| `contract-tests` | `cpu` | — | fixtures, API snapshots, runtime surfaces |
| `cdk-go-drift` | `repo-write` | — | `cdk/`, `cdk-go/`, generation scripts |
| `deterministic-builds` | `repo-write` | — | packaging inputs and scripts |
| `examples-local` | `docker` | — | examples, local harness, synth proof |
| `security-refresh` | `network` | — | dependency manifests and scan script |
| `rubric` | `repo-write` | `go`, `unit`, `contract-tests`, `cdk-go-drift`, `deterministic-builds` | all source, docs and governance inputs |

The tracked default is two workers. `cpu` admits two Go-family jobs; every
filesystem/build writer shares the single `repo-write` resource group, so an
expensive Go/jsii/rubric build never oversubscribes this host. Docker and network
work can overlap with CPU work. A command may declare its own resource group or
a `sharedKey`; commands that share a `sharedKey` execute exactly once per run
and carry explicit `sharedFrom` attribution.

Completed records are written atomically as each gate finishes. An interrupted
run keeps its completed records, publishes nothing for an incomplete gate and
returns a non-zero status. A restart executes only the incomplete or changed
work. Cancellation terminates every owned process group; the collector never
returns green while a child failed or leaves an owned writer running.

## Composition instead of duplicated re-execution

The rubric no longer blindly repeats work that another gate already produced.
Its command exports `APPTHEORY_EVIDENCE_REUSE` for the product gates it depends
on. The leaf entry points call `scripts/evidence/reuse-if-recorded.sh`, which
verifies the named record against the exact candidate inputs and never executes
a recorded command. A missing, stale, mismatched or failed record falls through
to the real command, so composition can reduce repeated work but can never
fabricate a pass.

The consumed records are written into the rubric record's `consumed` list with
their scope digests and timestamps. That is the coverage attribution: a green
rubric means either the composed record verified or the real check ran inside
the rubric. Verification of a composed record also re-verifies every consumed
dependency record against the current inputs; deleting or changing one makes
the composed record inapplicable instead of leaving a stale green. The two-pass
deterministic build unsets the reuse environment in its inner passes, so a
nested leaf can never turn the determinism proof into a no-op.

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
contract corpus, examples harness or language test suites.

## Record schema

Records live at `gov-infra/evidence/proportionate/<gate>.json` and are tracked.
Local logs live under `gov-infra/evidence/proportionate/local/` and stay ignored;
the record carries only their digest and a reference.

```json
{
  "schemaVersion": 1,
  "gate": "rubric",
  "kind": "source",
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

Commands, exit codes, timestamps, log digests, per-command `inputsDigest` values
and the environment are validated strictly. Records with unknown keys,
unapproved commands, non-zero exits, malformed digests or a `FAIL` verdict are
never reused. The collector retains a failed record honestly and exits non-zero.

Records written before the scope-binding change lack `scope` and
`commands[].inputsDigest`. They are historical provenance, not reusable proof:
the verifier reports them as unsupported and the collector recollects the
affected gate. It does not edit an old record into a new pass.

## Workflow

```bash
# Enumerate every approved gate; only missing/affected work executes.
scripts/evidence/collect.sh --all

# Or only the gates affected by a follow-up source fix.
scripts/evidence/collect.sh --gate go --gate ts

# Verify without executing anything named by the record.
scripts/evidence/verify.sh --gate rubric

# Reuse applicable proof, otherwise execute the approved commands (CI entry point).
scripts/evidence/verify-or-execute.sh --gate rubric

# Add reviewer references after review without invalidating input identity.
python3 scripts/evidence/validation_evidence.py finalize --all --review-ref factory-review-1234
```

Review references are recorded after the reviewers can see the candidate, so
finalization never demands future review IDs. Adding references or any other
evidence-only file does not change the scope digest. Signing applies to the
evidence-only commit like any other commit.

Collection requires a clean worktree outside the evidence directory. Commit the
source first, collect, then commit the records (signed). A source fix after
review invalidates only the affected gates; recollect those gates, or run
`--all` and let the scheduler decide.

## Applicability summary in CI

Every evidence-aware job prints one unambiguous line and a job-summary entry:

- `gate <id>: evidence-verified (no command executed in this run)`; or
- `gate <id>: executing (<reason>)` followed by the real approved command.

The staging required context keeps its name, `Rubric (full gate set)`. A green
state means the recorded proof was verified for the candidate inputs, not that
the command was executed in that run. When a committed record does not apply,
the gate executes its real command; that is the missing-proof fallback, not a
silent pass.

The PR lane runs workflow code from the candidate. That is acceptable because
all PR-lane permissions are read-only, the verifier never executes record
contents, and paired review inspects the workflow and evidence diff. Privileged
release operations run only from protected branches.

## Execution matrix

| Leg | Event | Old behavior | New behavior |
| --- | --- | --- | --- |
| `pr-staging` | pull request → staging | every job executes on the merge ref | required product jobs reuse applicable evidence; untrusted or unmatched inputs execute |
| `push-staging` | merge push → staging | every job re-executes on the merged tree | product jobs reuse the merged tree's evidence; release/security gates execute cheaply |
| `pr-staging-premain` | staging → premain promotion PR | CI product set plus promotion readiness/eligibility | promotion readiness/eligibility plus evidenced product checks; no source rerun |
| `push-premain` | promotion merge push → premain | CI product set re-executes, then release-please generates the RC PR | CI reuses evidence; release-please generation and artifact sync run |
| `release-pr-premain` | generated RC release PR | dispatched CI re-executes the product suite on generated artifacts | release-delta packaging/drift smoke once; product jobs skip the release-only transformation |
| `release-merge-premain` | RC merge/publish on premain | CI product set re-executes, then the publisher builds assets again | product checks skip the generated merge commit; signatures and version state run; publisher builds real assets once |
| `pr-premain-main` | premain → main promotion PR | CI product set plus promotion readiness/eligibility | promotion readiness/eligibility plus evidenced product checks; no source rerun |
| `push-main` | promotion merge push → main | CI product set re-executes, then release-please generates the stable PR | CI reuses evidence; release-please generation and artifact sync run |
| `release-pr-main` | generated stable release PR | dispatched CI re-executes the product suite on generated artifacts | release-delta packaging/drift smoke once; product jobs skip the release-only transformation |
| `release-merge-main` | stable merge/publish on main | CI product set re-executes, then the publisher builds assets again | product checks skip the generated merge commit; signatures and version state run; publisher builds real assets once |
| `backmerge-main-staging` | main → staging back-merge PR | full rubric, builds, examples and matrix re-execute | evidenced pure version-transformation reuse; a real source delta executes the affected gates |

Gates that execute in a distinct floor environment (Node 22, Python 3.12, the CDK
Node floor) stay real CI runs. A local macOS proof is reviewer-inspected
provenance for source and toolchain gates, but it is never presented as coverage
of a different floor environment. Gates whose artifact claim is platform-bound
(`deterministic-builds`, `examples-local`) bind `toolchain+platform`: a Linux CI
run executes its own real proof instead of reusing a macOS record.

## Known limits

- Evidence proves the inputs and the cooperating implementation, not a
  cryptographic attestation of execution.
- The generated release transformation is bounded by the explicit release-only
  path set, version-normalized equality and `release-delta` regeneration
  equality. A change outside that set is a source change and requires the
  affected validation.
- The scheduler's per-gate input scopes are conservative declarations. A new
  file outside every declared product scope is treated as unknown and forces
  broad execution; it is never silently inherited as green.
- Publish remains real-path evidence: local and PR proof does not prove GitHub
  publication.
