# AppTheory Threat Model (custom — v1.0.0)

This document enumerates the highest-risk threats for the in-scope system and assigns stable IDs (`THR-*`) that must map
to controls in `gov-infra/planning/apptheory-controls-matrix.md`.

## Scope (must be explicit)
- **System:** AppTheory — a multi-language (Go/TypeScript/Python) serverless application framework that normalizes AWS event inputs, provides a consistent routing/middleware/response model (including streaming), and verifies behavior via contract fixtures.
- **In-scope data:** request/response payloads (may contain user-provided data, potentially including PII), headers, auth tokens, secrets passed via env vars/config, build artifacts, telemetry/logs.
- **Environments:** local dev, CI, user deployments on AWS (Lambda + API Gateway/ALB/WebSockets/Step Functions). “prod-like” means: same runtimes (Go 1.25.x, Node 24.x, Python 3.14.x) and the same packaging steps used for releases.
- **Third parties:** AWS, GitHub Actions, npm registry, PyPI, Go module ecosystem (proxy/sumdb), and CDK tooling.
- **Out of scope:** AWS account/IAM configuration for user applications; user application code; customer data retention policies in downstream services; operational monitoring stacks (unless provided by AppTheory itself).
- **Assurance target:** “audit-ready engineering controls” — deterministic verifiers, pinned toolchains, repeatable evidence, and anti-drift guardrails.

## Assets and Trust Boundaries (high level)
- **Primary assets:** framework correctness guarantees; cross-language contract fixtures; release artifacts (Go module, npm tarballs, Python wheels/sdists, CDK constructs); CI provenance.
- **Trust boundaries:**
  - user-provided AWS event payloads → AppTheory normalization layer
  - framework public API boundary → user application code
  - build system / CI → registries (Go proxy/sumdb, npm, PyPI)
  - CDK examples → synthesized templates
- **Entry points:**
  - AWS event inputs (ALB/APIGW/WebSocket/Step Functions)
  - framework public API calls (handler/middleware)
  - contract fixture runner inputs
  - build and packaging commands (`make rubric`, `npm pack`, `python -m build`)

## Top Threats (stable IDs)
Threat IDs must be stable over time. When a new class of risk is discovered:
1) add a new `THR-*`,
2) add/adjust controls in the controls matrix,
3) update the rubric/roadmap if a new verifier is required.

| Threat ID | Title | What can go wrong | Primary controls (Control IDs) | Verification (gate) |
| --- | --- | --- | --- | --- |
| THR-1 | Cross-language semantic mismatch | Go/TS/Python implementations diverge (headers/body/status/streaming), producing inconsistent behavior and security assumptions. | CON-3, QUA-2, DOC-5 | `scripts/verify-contract-tests.sh` |
| THR-2 | Streaming response correctness failure | Streaming responses truncate, leak data across requests, or violate platform expectations (Lambda/APIGW). | CON-3, QUA-2 | `scripts/verify-contract-tests.sh` |
| THR-3 | Dependency or toolchain supply-chain compromise | Malicious dependency versions or lifecycle scripts execute during install/build, leaking tokens or modifying artifacts. | SEC-3, SEC-2, COM-2 | SEC-3 supply-chain gate (via `gov-verify-rubric.sh`) |
| THR-4 | Non-reproducible builds / provenance drift | Artifacts differ per build environment or time; release tags do not correspond to source; tool versions drift. | COM-2, SEC-4 | `scripts/verify-builds.sh` |
| THR-5 | Sensitive data exposure via logging | Raw payloads/headers/tokens get logged or included in errors, leaking secrets/PII. | COM-6 | COM-6 logging-ops gate (via `gov-verify-rubric.sh`) |
| THR-6 | Go correctness / safety regressions | Context misuse, ignored errors, unsafe conversions, or insecure patterns slip in. | CON-2, SEC-1, QUA-1 | `make lint` + `make test-unit` |
| THR-7 | Input normalization vulnerabilities | Inconsistent normalization enables header injection, incorrect base64 handling, or request smuggling-ish behaviors. | CON-3, QUA-2 | `scripts/verify-contract-tests.sh` |
| THR-8 | Install-time script execution | Postinstall/prepare scripts execute unexpected commands (curl|sh, token access, exfil). | SEC-3 | SEC-3 supply-chain gate (via `gov-verify-rubric.sh`) |
| THR-9 | Evidence/doc drift (“paper security”) | Docs claim controls exist, but verifiers don’t run or evidence isn’t reproducible; threats are unmapped. | DOC-4, DOC-5, CMP-1..3 | `bash gov-infra/verifiers/gov-verify-rubric.sh` |
| THR-10 | Example/CDK drift breaks real deployments | Examples or CDK stacks stop synthesizing or diverge from snapshot; users copy broken patterns. | COM-1, QUA-2 | `scripts/verify-cdk-synth.sh` + `scripts/verify-testkit-examples.sh` |

## Parity Rule (no “named threat without control”)
- Every `THR-*` listed above must appear at least once in the controls matrix “Threat IDs” column.
- The repo must have a deterministic parity check (used by `gov validate`) that fails if any threat is unmapped.

## Notes
- Keep raw standards text out of the repo when licensing is uncertain; reference KBs by ID/path.
- Prefer threats phrased as “failure modes” the repo can actually prevent or detect.
