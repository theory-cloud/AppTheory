# AppTheory Controls Matrix (custom — v1.0.0)

This matrix is the “requirements → controls → verifiers → evidence” backbone for AppTheory. It is intentionally
engineering-focused: it does not claim compliance, but it makes security/quality assertions traceable and repeatable.

## Scope
- **System:** AppTheory — a multi-language (Go/TypeScript/Python) serverless application framework that normalizes AWS event inputs, provides a consistent routing/middleware/response model (including streaming), and verifies behavior via contract fixtures.
- **In-scope data:** request/response payloads (may contain user-provided data, potentially including PII), headers, auth tokens, secrets passed via env vars/config, build artifacts, telemetry/logs.
- **Environments:** local dev, CI, user deployments on AWS (Lambda + API Gateway/ALB/WebSockets/Step Functions). “prod-like” means: same runtimes (Go 1.25.x, Node 24.x, Python 3.14.x) and the same packaging steps used for releases.
- **Third parties:** AWS, GitHub Actions, npm registry, PyPI, Go module ecosystem (proxy/sumdb), and CDK tooling.
- **Out of scope:** AWS account/IAM configuration for user applications; user application code; customer data retention policies in downstream services; operational monitoring stacks (unless provided by AppTheory itself).
- **Assurance target:** “audit-ready engineering controls” — deterministic verifiers, pinned toolchains, repeatable evidence, and anti-drift guardrails.

## Threats (reference IDs)
- Enumerate threats as stable IDs (`THR-*`) in `gov-infra/planning/apptheory-threat-model.md`.
- Each `THR-*` must map to ≥1 row in the controls table below (validated by a deterministic parity check).

## Status (evidence-driven)
If you track implementation status, treat it as evidence-driven:
- `unknown`: no verifier/evidence yet
- `partial`: some controls exist but coverage/evidence is incomplete
- `implemented`: verifier exists and evidence path is repeatable

## Engineering Controls (Threat → Control → Verifier → Evidence)
This table is the canonical mapping used by the rubric/roadmap/evidence plan.

| Area | Threat IDs | Control ID | Requirement | Control (what we implement) | Verification (command/gate) | Evidence (artifact/location) |
| --- | --- | --- | --- | --- | --- | --- |
| Quality | THR-1, THR-2, THR-6 | QUA-1 | Unit tests prevent regressions | Go unit tests run for all packages in the root module. | `make test-unit` | `gov-infra/evidence/QUA-1-output.log` |
| Quality | THR-1, THR-2, THR-7, THR-10 | QUA-2 | Integration and runtime smoke tests stay green | Deterministic example/testkit runs validate “real runtime” behavior across languages. | `scripts/verify-testkit-examples.sh` | `gov-infra/evidence/QUA-2-output.log` |
| Quality | THR-1, THR-6 | QUA-3 | Coverage threshold is enforced (no dilution) | Coverage is measured for Go code and a floor is enforced. | `check_go_coverage` (inside `gov-verify-rubric.sh`) | `gov-infra/evidence/QUA-3-output.log` + `gov-infra/evidence/go-coverage.out` |
| Consistency | — | CON-1 | Formatting is clean (no diffs) | `gofmt` is enforced on tracked Go files. | `make fmt-check` | `gov-infra/evidence/CON-1-output.log` |
| Consistency | THR-6 | CON-2 | Lint/static analysis is enforced (pinned toolchain) | Go lint (golangci-lint), TS lint (eslint), Python lint (ruff) all run and are enforced. | `make lint` | `gov-infra/evidence/CON-2-output.log` |
| Consistency | THR-1, THR-2, THR-7, THR-9 | CON-3 | Public boundary contract parity (cross-language behavior) | Contract fixtures validate equivalent semantics across Go/TS/Python runners. | `scripts/verify-contract-tests.sh` | `gov-infra/evidence/CON-3-output.log` |
| Completeness | THR-4, THR-10 | COM-1 | All modules compile (no “mystery meat”) | Root module, CDK Go module(s), and build outputs compile/test. | `check_multi_module_health` (inside `gov-verify-rubric.sh`) | `gov-infra/evidence/COM-1-output.log` |
| Completeness | THR-4 | COM-2 | Toolchain pins align to repo expectations | CI pins (Go/Node/Python + golangci-lint) are consistent with repo declarations. | `check_toolchain_pins` (inside `gov-verify-rubric.sh`) | `gov-infra/evidence/COM-2-output.log` |
| Completeness | THR-4, THR-6 | COM-3 | Lint config schema-valid (no silent skip) | Lint configs are validated, and lint runs use explicit config files. | `check_lint_config_valid` (inside `gov-verify-rubric.sh`) | `gov-infra/evidence/COM-3-output.log` |
| Completeness | THR-4 | COM-4 | Coverage threshold not diluted (≥ 60%) | The rubric’s declared coverage threshold is ≥ 60% and matches the verifier floor. | `check_coverage_threshold_floor` (inside `gov-verify-rubric.sh`) | `gov-infra/evidence/COM-4-output.log` |
| Completeness | THR-3 | COM-5 | Security scan config not diluted (no excluded high-signal rules) | Go security lint (`gosec`) remains enabled; suppressions stay narrow. | `check_security_config` (inside `gov-verify-rubric.sh`) | `gov-infra/evidence/COM-5-output.log` |
| Completeness | THR-5 | COM-6 | Logging/operational standards enforced (if applicable) | Logging policies (redaction/no raw payloads) are enforced by a deterministic verifier. | **BLOCKED** — logging policy gate not yet implemented (planned in roadmap M4) | `gov-infra/evidence/COM-6-output.log` |
| Security | THR-6 | SEC-1 | Baseline SAST stays green | Static analysis includes security-focused rules (e.g., `gosec`) and stays green. | `scripts/verify-go-lint.sh` | `gov-infra/evidence/SEC-1-output.log` |
| Security | THR-3 | SEC-2 | Dependency vulnerability scan stays green | Vulnerability scanning is run with pinned tooling and fails closed. | **BLOCKED** — pinned vulnerability scanning not yet implemented (plan: roadmap M3) | `gov-infra/evidence/SEC-2-output.log` |
| Security | THR-3, THR-8 | SEC-3 | Supply-chain verification stays green | Supply-chain checks: GitHub Actions integrity pinning + dependency script/IIOC scanning. | SEC-3 supply-chain gate (via `gov-verify-rubric.sh`) | `gov-infra/evidence/SEC-3-output.log` |
| Security | THR-4 | SEC-4 | P0 integrity regression tests stay green | Deterministic build verification to detect non-reproducible artifacts and drift. | `scripts/verify-builds.sh` | `gov-infra/evidence/SEC-4-output.log` |
| Docs | THR-9 | DOC-4 | Doc integrity (links, version claims) | Governance docs contain no unrendered tokens and match pack metadata expectations. | `check_doc_integrity` (inside `gov-verify-rubric.sh`) | `gov-infra/evidence/DOC-4-output.log` |
| Docs | THR-9 | DOC-5 | Threat model ↔ controls parity (no unmapped threats) | All threat IDs in the threat model map to at least one controls matrix row. | (built into verifier) | `gov-infra/evidence/DOC-5-parity.log` |

> Add rows as needed for additional anti-drift (multi-module health, CI rubric enforcement),
> supply-chain/release integrity, and future domain-specific P0 gates.

## Framework Mapping (Optional; for PCI/HIPAA/SOC2)
This repo currently uses a **custom** domain pack (no framework assumptions). If a compliance framework applies later:
- keep standards text out-of-repo (license constraints may apply),
- store only requirement IDs + short titles,
- reference a KB path/env var (e.g., `PCI_KB_PATH`).

## Notes
- Prefer deterministic verifiers (tests, static analysis, IaC assertions) over manual checklists.
- Treat this matrix as “source material”: the rubric/roadmap/evidence plan must stay consistent with Control IDs here.
