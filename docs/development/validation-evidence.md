# Proportionate release validation

AppTheory keeps the same required checks, signing rules and release discipline,
but executes expensive proof once per real input set instead of once per event.
The operator authorized this execution-policy change on 2026-11-12. It changes
**where and how often** proof runs. It does not remove a check, lower a
threshold, weaken a gate, alter branch protection or accept a self-declared
result.

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
The release-only projection also stores a normalized digest computed after
substituting the recorded `VERSION` literal with a fixed token. When the source
digest matches and only the release-only projection differs, an equal
normalized digest proves the delta is exactly the version substitution release
automation performs. Any other release-only edit, or any source edit, requires
the affected validation to run again.

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
      "logRef": "gov-infra/evidence/proportionate/local/rubric-rubric-….log"
    }
  ],
  "reviews": [{"ref": "factory-review-…", "kind": "review-reference"}],
  "producer": {"tool": "scripts/evidence/validation_evidence.py", "registry": "validation-gates.json"}
}
```

A dependency scan adds `dependency.digest` and `scan.scannedAt` plus
`scan.maxAgeSeconds`. The tracked default is 86 400 seconds. Future timestamps,
invalid timestamps and scans older than the bound are rejected, and a stale scan
refreshes only the dependency scan.

Commands, exit codes, timestamps, log digests and the environment are validated
strictly. Records with unknown keys, unapproved commands, non-zero exits,
malformed digests or a `FAIL` verdict are never reused. The collector retains a
failed record honestly and exits non-zero.

## Workflow

```bash
# Collect every approved gate once on a clean final tree.
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
evidence-only file does not change the source digest. Signing applies to the
evidence-only commit like any other commit.

Collection requires a clean worktree outside the evidence directory. Commit the
source first, collect, then commit the records (signed). A source fix after
review invalidates the affected records; recollect only the affected gates.

## Applicability summary in CI

Every evidence-aware job prints one unambiguous line and a job-summary entry:

- `gate <id>: evidence-verified (no command executed in this run)`; or
- `gate <id>: executing (<reason>)` followed by the real approved command.

The staging required context keeps its name, `Rubric (full gate set)`. A green
state means the recorded proof was verified for the candidate inputs, not that
the command was executed in that run.

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
provenance for the source and packaging gates, but it is never presented as
coverage of a different floor environment; the record prints its platform so
reviewers can see the difference.

## Known limits

- Evidence proves the inputs and the cooperating implementation, not a
  cryptographic attestation of execution.
- The generated release transformation is bounded by the explicit release-only
  path set, version-normalized equality and `release-delta` regeneration
  equality. A change outside that set is a source change and requires the
  affected validation.
- Publish remains real-path evidence: local and PR proof does not prove GitHub
  publication.
