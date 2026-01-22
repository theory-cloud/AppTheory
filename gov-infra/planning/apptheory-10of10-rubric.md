# AppTheory: 10/10 Rubric (Quality, Consistency, Completeness, Security, Compliance Readiness, Maintainability, Docs)

This rubric defines what “10/10” means and how category grades are computed. It is designed to prevent goalpost drift and
“green by dilution” by making scoring **versioned, measurable, and repeatable**.

## Versioning (no moving goalposts)
- **Rubric version:** `v1.2.0` (2026-01-22)
- **Comparability rule:** grades are comparable only within the same version.
- **Change rule:** bump the version + changelog entry for any rubric change (what changed + why).

### Changelog
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
| QUA-3 | 3 | Coverage ≥ 75% (Go/TypeScript/Python; no denominator games) | `check_coverage` (inside `gov-verify-rubric.sh`) |

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
| COM-4 | 2 | Coverage threshold not diluted (≥ 75%) | `check_coverage_threshold_floor` (inside `gov-verify-rubric.sh`) |
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

## Compliance Readiness (CMP) — auditability and evidence
| ID | Points | Requirement | How to verify |
| --- | ---: | --- | --- |
| CMP-1 | 4 | Controls matrix exists and is current | File exists: `gov-infra/planning/apptheory-controls-matrix.md` |
| CMP-2 | 3 | Evidence plan exists and is reproducible | File exists: `gov-infra/planning/apptheory-evidence-plan.md` |
| CMP-3 | 3 | Threat model exists and is current | File exists: `gov-infra/planning/apptheory-threat-model.md` |

**10/10 definition:** CMP-1 through CMP-3 pass.

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
| DOC-1 | 2 | Threat model present | File exists: `gov-infra/planning/apptheory-threat-model.md` |
| DOC-2 | 2 | Evidence plan present | File exists: `gov-infra/planning/apptheory-evidence-plan.md` |
| DOC-3 | 2 | Rubric + roadmap present | Files exist: `gov-infra/planning/apptheory-10of10-rubric.md`, `gov-infra/planning/apptheory-10of10-roadmap.md` |
| DOC-4 | 2 | Doc integrity (tokens, version claims) | `check_doc_integrity` (inside `gov-verify-rubric.sh`) |
| DOC-5 | 2 | Threat ↔ controls parity | (built into verifier; writes `gov-infra/evidence/DOC-5-parity.log`) |

**10/10 definition:** DOC-1 through DOC-5 pass.

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
