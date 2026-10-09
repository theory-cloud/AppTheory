# AppTheory: 10/10 Rubric (Quality, Consistency, Completeness, Security, Compliance Readiness, Maintainability, Docs)

This rubric defines what “10/10” means and how category grades are computed. It is designed to prevent goalpost drift and
“green by dilution” by making scoring **versioned, measurable, and repeatable**.

## Versioning (no moving goalposts)
- **Rubric version:** `v1.5.1` (2026-06-08)
- **Comparability rule:** grades are comparable only within the same version.
- **Change rule:** bump the version + changelog entry for any rubric change (what changed + why).

### Changelog
- `v1.5.1`: Align the AppTheory release lifecycle gate with the served `gov_rubric_report.v1` schema by reporting it as `CMP-4` while preserving the same repo-local release verifier.
- `v1.5.0`: Add release lifecycle governance evidence for the single AppTheory release train, including release state, promotion, and workflow invariant checks.
- `v1.4.0`: Enforce the Pay Theory documentation standard across shipped packages (repo docs + TS/Py/CDK docs), including the YAML knowledge-base triad, via deterministic verification.
- `v1.3.0`: Raise the coverage requirement to **≥ 90%** across all shipped runtimes (Go/TypeScript/Python) and enforce the same floor in the verifier.
- `v1.2.0`: Raise the coverage requirement to **≥ 75%** across all shipped runtimes (Go/TypeScript/Python) and enforce the same floor in the verifier.
- `v1.1.0`: Expand unit-test and coverage scope to **all shipped runtimes** (Go/TypeScript/Python). Previously the rubric and verifier only enforced Go coverage.
- `v1.0.0`: Initial GovTheory rubric for AppTheory (custom domain). Establishes cross-language contract parity, multi-module health, supply-chain checks, and anti-drift gates.

## Scoring (deterministic)
- Each category is scored **0–10**.
- Point weights sum to **10** per category.
- Requirements are **pass/fail** (either earn full points or 0).
- A category is **10/10 only if all requirements in that category pass**.

## Verification (commands + deterministic artifacts are the source of truth)
Every rubric item has exactly one verification mechanism:
- a command (`make ...`, `go test ...`, `bash scripts/...`), or
- a deterministic artifact check (required doc exists and matches an agreed format).

Enforcement rule (anti-drift):
- If an item’s verifier is a command/script, it only counts as passing once it runs in CI and produces evidence.

---

## Quality (QUA) — reliable, testable, change-friendly
| ID | Points | Requirement | How to verify |
| --- | ---: | --- | --- |
| QUA-1 | 4 | Unit tests stay green (Go/TypeScript/Python) | `gov_cmd_unit` (inside `gov-verify-rubric.sh`) |
| QUA-2 | 3 | Integration/runtime tests stay green | `scripts/verify-testkit-examples.sh` |
| QUA-3 | 3 | Coverage ≥ 90% (Go/TypeScript/Python; no denominator games) | `check_coverage` (inside `gov-verify-rubric.sh`) |

**10/10 definition:** QUA-1 through QUA-3 pass.

## Consistency (CON) — one way to do the important things
| ID | Points | Requirement | How to verify |
| --- | ---: | --- | --- |
| CON-1 | 3 | Formatter clean (no diffs) | `make fmt-check` |
| CON-2 | 5 | Lint/static analysis green (pinned version) | `make lint` |
| CON-3 | 2 | Public boundary contract parity (cross-language semantics) | `scripts/verify-contract-tests.sh` |

**10/10 definition:** CON-1 through CON-3 pass.

## Completeness (COM) — verify the verifiers (anti-drift)
| ID | Points | Requirement | How to verify |
| --- | ---: | --- | --- |
| COM-1 | 2 | All modules compile (no “mystery meat”) | `check_multi_module_health` (inside `gov-verify-rubric.sh`) |
| COM-2 | 2 | Toolchain pins align to repo (Go/Node/Python + lint tools) | `check_toolchain_pins` (inside `gov-verify-rubric.sh`) |
| COM-3 | 2 | Lint config schema-valid (no silent skip) | `check_lint_config_valid` (inside `gov-verify-rubric.sh`) |
| COM-4 | 2 | Coverage threshold not diluted (≥ 90%) | `check_coverage_threshold_floor` (inside `gov-verify-rubric.sh`) |
| COM-5 | 1 | Security scan config not diluted (no excluded high-signal rules) | `check_security_config` (inside `gov-verify-rubric.sh`) |
| COM-6 | 1 | Logging/operational standards enforced (if applicable) | `check_logging_ops_standards` (inside `gov-verify-rubric.sh`) |

**10/10 definition:** COM-1 through COM-6 pass.

## Security (SEC) — abuse-resilient and reviewable
| ID | Points | Requirement | How to verify |
| --- | ---: | --- | --- |
| SEC-1 | 3 | Static security scan green (pinned version) | `scripts/verify-go-lint.sh` |
| SEC-2 | 3 | Dependency vulnerability scan green | `gov_cmd_vuln` (inside `gov-verify-rubric.sh`) |
| SEC-3 | 2 | Supply-chain verification green | `check_supply_chain` (inside `gov-verify-rubric.sh`) |
| SEC-4 | 2 | P0 integrity regression tests (build determinism) | `scripts/verify-builds.sh` |

**10/10 definition:** SEC-1 through SEC-4 pass.

### SEC-2 dependency-audit exceptions: two operator-ruled AWS exceptions

SEC-2 grants **no dependency-audit exceptions** beyond the two below. Each is an exact match (lockfile,
package, version, node path / dependency chain, and advisory ids) and is **self-expiring and
fail-closed**: it carries a hard `recheck_by` deadline, a registry-backed removal probe runs on every
invocation so a stale exception cannot survive by never matching again, and when a removal condition is
met the checker fails with a clear message. Any *other* finding, in any lockfile, still fails the gate.
Nothing beyond these two may be added without a new operator ruling.

Operator rulings, quoted verbatim:

> 2026-10-03: "if a vulnerable dependency is bundled in AWS we make an exception until its updated there."

> 2026-10-04: the same treatment applies, for consistency, to AWS-published build toolchain transitive
> chains with no upstream fix.

**E1 - brace-expansion 5.0.9 bundled inside aws-cdk-lib.** Findings `GHSA-q2hr-2g5m-vwhr`,
`GHSA-qhr7-859c-m2p7`, and `GHSA-6j4f-fj2g-mc7p` on `brace-expansion@5.0.9` at
`node_modules/aws-cdk-lib/node_modules/brace-expansion` (bundled), reached only through aws-cdk-lib's own
bundled `minimatch`. AWS publishes it and only AWS can publish a tarball that bundles the patched
release (`brace-expansion >= 5.0.12` exists on npm but cannot be installed into the bundled subtree); it
is build-time only and no AppTheory runtime package or Lambda ships it. Scope (widened 2026-10-06):
every npm lockfile in this repository whose installed tree carries that bundled path -
`cdk/package-lock.json` plus all twelve `examples/cdk/*/package-lock.json` files. Before the widening the
scope was cdk/ plus four examples, which left eight example lockfiles carrying the identical vulnerable
AWS path with no gate coverage and no recorded exception; the SEC-2 Node scan set is now the same full
list, so every lockfile is either reported vulnerable or reported excepted. Owner: AppTheory steward
(Factory dependency sweeps). **Removal condition:** the
`aws-cdk-lib` version this repository pins bundles `brace-expansion >= 5.0.12`. **Hard recheck by
2026-11-02.**

**E2 - braces 3.0.3 in the jsii build toolchain.** Finding `GHSA-vfj7-8cjw-p6xm` (high) on `braces@3.0.3`
at `node_modules/braces`, reached only via `jsii-pacmak -> jsii-rosetta -> fast-glob -> micromatch ->
braces`; npm also lists the derived `micromatch`, `fast-glob`, `jsii-rosetta`, and `jsii-pacmak` entries,
which are pure propagation of this single advisory. The advisory's range is `affected <= 3.0.3` and npm
publishes **no** patched `braces`, so no installable version pair clears it; the chain is the dev
toolchain of the cdk devDependency `jsii-pacmak`, build-time only. Scope: `cdk/package-lock.json` only
(the example lockfiles do not carry the jsii chain). **Removal condition:** a patched `braces` (> 3.0.3)
is published, or the jsii toolchain no longer resolves `braces <= 3.0.3`. **Hard recheck by 2026-11-02.**

Both exceptions live in the ONE shared list in `scripts/check-visible-aws-cdk-finding.mjs`; the npm and
OSV scanner paths match findings against that same list, `scripts/verify-cdk-audit.sh` and
`gov-verify-rubric.sh`'s `osv_scan_lockfile` accept a non-zero scanner exit only when the checker emits
the `exception-applied:` machine marker, and the checker's `--self-test` battery proves the negative
cases (a different advisory id, version, node path, or lockfile, an expired `recheck_by`, or a met
removal condition) still fail closed.

This section previously recorded that SEC-2 carried **no** exception. The pattern reused here is the one
SEC-2's earlier exception established: advisory `GHSA-528h-pc64-c93x` / `CVE-2026-71429` for
`stream-json < 3.5.0`, reached only through `jsii-rosetta` (a peer of the `jsii-pacmak` cdk
devDependency), operator-ruled 2026-09-20 (Factory sweep 2026-09; companion to PR #998) and matched
exactly (no severity, count, or blanket allowlists). It was upstream-blocked: every patched `stream-json`
release was ESM-only, which broke `jsii-rosetta`'s CommonJS subpath requires under `jsii-pacmak`, while
every stable `jsii-rosetta` inside `jsii-pacmak`'s peer range (`>= 5.9.0`, 5.9.0 through 6.0.15) pinned
`stream-json ^1.9.1`.

**Resolution (2026-09-22).** That exception's own removal condition fired: the npm registry published a
STABLE `jsii-rosetta >= 6.0.16`, `cdk/package.json` now pins `jsii-rosetta 6.0.16`, and
`cdk/package-lock.json` resolves `stream-json` 3.7.0, so `npm audit` on `cdk/` reported an empty
vulnerability map. The exception and all of its machinery were removed at the time and are re-created
here, narrowed to the two AWS-blocked findings above.

## Compliance Readiness (CMP) — auditability and evidence
| ID | Points | Requirement | How to verify |
| --- | ---: | --- | --- |
| CMP-1 | 3 | Controls matrix exists and is current | File exists: `gov-infra/planning/apptheory-controls-matrix.md` |
| CMP-2 | 2 | Evidence plan exists and is reproducible | File exists: `gov-infra/planning/apptheory-evidence-plan.md` |
| CMP-3 | 2 | Threat model exists and is current | File exists: `gov-infra/planning/apptheory-threat-model.md` |
| CMP-4 | 3 | Release lane invariants stay enforced: `staging` → `premain` → `main` → `staging`, Release Please state, publisher recovery, and promotion guards | `check_release_lifecycle_invariants` (inside `gov-verify-rubric.sh`) |

**10/10 definition:** CMP-1 through CMP-4 pass.

## Maintainability (MAI) — convergent codebase (recommended for AI-heavy repos)
| ID | Points | Requirement | How to verify |
| --- | ---: | --- | --- |
| MAI-1 | 4 | File-size/complexity budgets enforced | `check_file_budgets` (inside `gov-verify-rubric.sh`) |
| MAI-2 | 3 | Maintainability roadmap current | `check_maintainability_roadmap` (inside `gov-verify-rubric.sh`) |
| MAI-3 | 3 | Canonical implementations (no duplicate semantics) | `check_duplicate_semantics` (inside `gov-verify-rubric.sh`) |

**10/10 definition:** MAI-1 through MAI-3 pass.

## Docs (DOC) — integrity and parity
| ID | Points | Requirement | How to verify |
| --- | ---: | --- | --- |
| DOC-1 | 1 | Threat model present | File exists: `gov-infra/planning/apptheory-threat-model.md` |
| DOC-2 | 1 | Evidence plan present | File exists: `gov-infra/planning/apptheory-evidence-plan.md` |
| DOC-3 | 1 | Rubric + roadmap present | Files exist: `gov-infra/planning/apptheory-10of10-rubric.md`, `gov-infra/planning/apptheory-10of10-roadmap.md` |
| DOC-4 | 2 | Gov doc integrity (tokens, version claims) | `check_doc_integrity` (inside `gov-verify-rubric.sh`) |
| DOC-5 | 2 | Threat ↔ controls parity | (built into verifier; writes `gov-infra/evidence/DOC-5-parity.log`) |
| DOC-6 | 3 | Pay Theory documentation standard enforced (packages) | `check_docs_standard` (inside `gov-verify-rubric.sh`) |

**10/10 definition:** DOC-1 through DOC-6 pass.

## Maintaining 10/10 (recommended CI surface)
Minimal command set CI should run in protected branches (no `latest` tools; pinned versions only):

```bash
make fmt-check
make lint
make test-unit
scripts/verify-testkit-examples.sh
scripts/verify-contract-tests.sh
bash gov-infra/verifiers/gov-verify-rubric.sh
```

Notes:
- `bash gov-infra/verifiers/gov-verify-rubric.sh` is the deterministic single entrypoint; it produces the machine report at
  `gov-infra/evidence/gov-rubric-report.json`.
- Items explicitly marked **BLOCKED** are treated as **BLOCKED** until implemented; do not remove them without a rubric version bump.
