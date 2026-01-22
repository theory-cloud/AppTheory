# AppTheory: 10/10 Roadmap (Rubric v1.1.0)

This roadmap maps milestones directly to rubric IDs with measurable acceptance criteria and verification commands.

## Current scorecard (Rubric v1.1.0)
Scoring note: a check is only treated as “passing” if it is both green **and** enforced by a trustworthy verifier
(pinned tooling, schema-valid configs, and no “green by dilution” shortcuts). Completeness failures invalidate “green by
drift”.

Until `bash gov-infra/verifiers/gov-verify-rubric.sh` is run in CI and archived, treat all grades as **unknown**.

| Category | Grade | Blocking rubric items |
| --- | ---: | --- |
| Quality | unknown | QUA-1, QUA-2, QUA-3 (not yet validated) |
| Consistency | unknown | CON-1, CON-2, CON-3 (not yet validated) |
| Completeness | unknown | COM-1..COM-6 (not yet validated) |
| Security | unknown | SEC-1..SEC-4 (not yet validated) |
| Compliance Readiness | in-scope | CMP-1..CMP-3 (files exist once committed) |
| Maintainability | unknown | MAI-1..MAI-3 (not yet validated) |
| Docs | unknown | DOC-1..DOC-5 (not yet validated) |

Evidence (refresh whenever behavior changes):
- `gov_cmd_unit` (via verifier)
- `scripts/verify-testkit-examples.sh`
- `check_coverage` (via verifier)
- `make fmt-check`
- `make lint`
- `check_multi_module_health` (via verifier)
- `check_toolchain_pins` (via verifier)
- `check_lint_config_valid` (via verifier)
- `check_coverage_threshold_floor` (via verifier)
- `check_security_config` (via verifier)
- `scripts/verify-go-lint.sh`
- SEC-3 supply-chain gate (via verifier)
- `scripts/verify-builds.sh`
- `check_doc_integrity` (via verifier)

## Rubric-to-milestone mapping
| Rubric ID | Status | Milestone |
| --- | --- | --- |
| QUA-1 | unknown | M1 |
| QUA-2 | unknown | M1 |
| QUA-3 | unknown | M2 |
| CON-1 | unknown | M0 |
| CON-2 | unknown | M1 |
| CON-3 | unknown | M1 |
| COM-1 | unknown | M0 |
| COM-2 | unknown | M0 |
| COM-3 | unknown | M0 |
| COM-4 | unknown | M2 |
| COM-5 | unknown | M2 |
| COM-6 | unknown | M4 |
| SEC-1 | unknown | M2 |
| SEC-2 | unknown | M3 |
| SEC-3 | unknown | M3 |
| SEC-4 | unknown | M2 |
| CMP-1 | planned | M0 |
| CMP-2 | planned | M0 |
| CMP-3 | planned | M0 |
| MAI-1 | unknown | M4 |
| MAI-2 | unknown | M4 |
| MAI-3 | unknown | M5 |
| DOC-1 | planned | M0 |
| DOC-2 | planned | M0 |
| DOC-3 | planned | M0 |
| DOC-4 | unknown | M0 |
| DOC-5 | unknown | M0 |

## Workstream tracking docs (when blockers require a dedicated plan)
Large remediation workstreams usually need their own roadmaps so they can be executed in reviewable slices and keep the
main roadmap readable:
- Lint remediation: `gov-infra/planning/apptheory-lint-green-roadmap.md`
- Coverage remediation: `gov-infra/planning/apptheory-coverage-roadmap.md`
- Supply-chain remediation: `gov-infra/planning/apptheory-workstream-supply-chain-roadmap.md`

## Milestones (sequenced)

### M0 — Freeze rubric + planning artifacts (anti-drift baseline)
**Closes:** CMP-1, CMP-2, CMP-3, DOC-1, DOC-2, DOC-3, DOC-4, DOC-5, COM-1, COM-2, COM-3

**Goal:** prevent goalpost drift by making the definition of “good” explicit and versioned.

**Acceptance criteria**
- `gov-infra/planning/` docs exist and contain no unrendered template tokens.
- `bash gov-infra/verifiers/gov-verify-rubric.sh` runs and produces `gov-infra/evidence/gov-rubric-report.json`.
- Threat IDs in the threat model are mapped in the controls matrix (DOC-5 passes).

### M1 — Make the core loop green (format/lint/tests)
**Closes:** CON-1, CON-2, CON-3, QUA-1, QUA-2

**Goal:** ensure developers/CI can run the core loop deterministically and it stays green.

Tracking document: `gov-infra/planning/apptheory-lint-green-roadmap.md`

**Acceptance criteria**
- `make fmt-check` passes.
- `make lint` passes with pinned tooling.
- `make test-unit` passes.
- `scripts/verify-testkit-examples.sh` passes.
- `scripts/verify-contract-tests.sh` passes.

### M2 — Coverage + security baseline gates
**Closes:** QUA-3, COM-4, COM-5, SEC-1, SEC-4

**Goal:** enforce quality/safety floors without denominator games.

Tracking document: `gov-infra/planning/apptheory-coverage-roadmap.md`

**Acceptance criteria**
- `check_coverage` passes with coverage ≥ 60% for Go/TypeScript/Python.
- `check_coverage_threshold_floor` passes (threshold not diluted).
- `scripts/verify-go-lint.sh` stays green (includes gosec).
- `scripts/verify-builds.sh` passes (build determinism).

### M3 — Supply-chain + dependency vulnerability gates
**Closes:** SEC-2, SEC-3

**Goal:** make supply-chain attacks and dependency drift harder.

Tracking document: `gov-infra/planning/apptheory-workstream-supply-chain-roadmap.md`

**Acceptance criteria**
- GitHub Actions are pinned by commit SHA (no `uses: ...@vN`).
- Dependency lifecycle scripts are scanned deterministically (Node projects), and suppressions are allowlisted with justification.
- A pinned vulnerability scan exists for the supported languages (Go/Node/Python), and fails closed.

### M4 — Operational/logging standards + maintainability budgets
**Closes:** COM-6, MAI-1, MAI-2

**Goal:** prevent slow drift (excessive file sizes, unreviewable complexity, and accidental sensitive logging).

**Acceptance criteria**
- A deterministic logging policy check exists and is enforced.
- File-size budgets are enforced and adjusted only with explicit justification.
- Maintainability work is tracked in this roadmap and reflected in the rubric report.

### M5 — Convergence: canonical implementations / duplicate semantics
**Closes:** MAI-3

**Goal:** prevent “multiple competing implementations” that make correctness/security fixes risky.

**Acceptance criteria**
- A deterministic duplicate-logic gate exists (initially heuristic; later semantic).
- Any exceptions are narrow and justified.
