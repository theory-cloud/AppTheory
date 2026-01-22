# AppTheory Evidence Plan (Rubric v1.4.0)

Defines where evidence for rubric items is produced and how to regenerate it. Evidence should be reproducible from a commit SHA (no hand-assembled screenshots unless unavoidable).

## Evidence sources

### CI artifacts (preferred)
- Coverage: `check_coverage` (via verifier) → Go/TS/Python summaries under `gov-infra/evidence/`
- Lint: `make lint` output (Go/TS/Python)
- Security: `scripts/verify-go-lint.sh` output (includes `gosec` via golangci-lint)
- Supply-chain: SEC-3 supply-chain gate (via verifier)

### Deterministic in-repo artifacts
- Controls matrix: `gov-infra/planning/apptheory-controls-matrix.md`
- Rubric: `gov-infra/planning/apptheory-10of10-rubric.md`
- Roadmap: `gov-infra/planning/apptheory-10of10-roadmap.md`
- Evidence plan: `gov-infra/planning/apptheory-evidence-plan.md`
- Supply-chain allowlist: `gov-infra/planning/apptheory-supply-chain-allowlist.txt`
- Threat model: `gov-infra/planning/apptheory-threat-model.md`
- AI drift recovery: `gov-infra/planning/apptheory-ai-drift-recovery.md`
- Signature bundle (local certification): `gov-infra/signatures/gov-signature-bundle.json`

## Rubric-to-evidence map
Every rubric ID maps to exactly one verifier and one primary evidence location.

| Rubric ID | Primary evidence | Evidence path | How to refresh |
| --- | --- | --- | --- |
| QUA-1 | Unit test output | `gov-infra/evidence/QUA-1-output.log` | `bash gov-infra/verifiers/gov-verify-rubric.sh` |
| QUA-2 | Integration/runtime output | `gov-infra/evidence/QUA-2-output.log` | `scripts/verify-testkit-examples.sh` |
| QUA-3 | Coverage summaries | `gov-infra/evidence/QUA-3-output.log` | `bash gov-infra/verifiers/gov-verify-rubric.sh` |
| CON-1 | Formatter diff list | `gov-infra/evidence/CON-1-output.log` | `make fmt-check` |
| CON-2 | Lint output | `gov-infra/evidence/CON-2-output.log` | `make lint` |
| CON-3 | Contract verification output | `gov-infra/evidence/CON-3-output.log` | `scripts/verify-contract-tests.sh` |
| COM-1 | Multi-module compile check | `gov-infra/evidence/COM-1-output.log` | `bash gov-infra/verifiers/gov-verify-rubric.sh` |
| COM-2 | Toolchain pin verification | `gov-infra/evidence/COM-2-output.log` | `bash gov-infra/verifiers/gov-verify-rubric.sh` |
| COM-3 | Lint config validation | `gov-infra/evidence/COM-3-output.log` | `bash gov-infra/verifiers/gov-verify-rubric.sh` |
| COM-4 | Coverage threshold floor check | `gov-infra/evidence/COM-4-output.log` | `bash gov-infra/verifiers/gov-verify-rubric.sh` |
| COM-5 | Security config validation | `gov-infra/evidence/COM-5-output.log` | `bash gov-infra/verifiers/gov-verify-rubric.sh` |
| COM-6 | Logging standards check | `gov-infra/evidence/COM-6-output.log` | `bash gov-infra/verifiers/gov-verify-rubric.sh` |
| SEC-1 | SAST/security lint output | `gov-infra/evidence/SEC-1-output.log` | `scripts/verify-go-lint.sh` |
| SEC-2 | Vulnerability scan output | `gov-infra/evidence/SEC-2-output.log` | `bash gov-infra/verifiers/gov-verify-rubric.sh` |
| SEC-3 | Supply-chain verification | `gov-infra/evidence/SEC-3-output.log` | `bash gov-infra/verifiers/gov-verify-rubric.sh` |
| SEC-4 | Deterministic build verification | `gov-infra/evidence/SEC-4-output.log` | `scripts/verify-builds.sh` |
| CMP-1 | Controls matrix exists | `gov-infra/planning/apptheory-controls-matrix.md` | File existence check |
| CMP-2 | Evidence plan exists | `gov-infra/planning/apptheory-evidence-plan.md` | File existence check |
| CMP-3 | Threat model exists | `gov-infra/planning/apptheory-threat-model.md` | File existence check |
| MAI-1 | File budget check | `gov-infra/evidence/MAI-1-output.log` | `bash gov-infra/verifiers/gov-verify-rubric.sh` |
| MAI-2 | Maintainability roadmap check | `gov-infra/evidence/MAI-2-output.log` | `bash gov-infra/verifiers/gov-verify-rubric.sh` |
| MAI-3 | Singleton check | `gov-infra/evidence/MAI-3-output.log` | `bash gov-infra/verifiers/gov-verify-rubric.sh` |
| DOC-1 | Threat model present | `gov-infra/planning/apptheory-threat-model.md` | File existence check |
| DOC-2 | Evidence plan present | `gov-infra/planning/apptheory-evidence-plan.md` | File existence check |
| DOC-3 | Rubric + roadmap present | `gov-infra/planning/apptheory-10of10-rubric.md` | File existence check |
| DOC-4 | Doc integrity (tokens, versions) | `gov-infra/evidence/DOC-4-output.log` | `bash gov-infra/verifiers/gov-verify-rubric.sh` |
| DOC-5 | Threat ↔ controls parity | `gov-infra/evidence/DOC-5-parity.log` | `bash gov-infra/verifiers/gov-verify-rubric.sh` |
| DOC-6 | Pay Theory documentation standard | `gov-infra/evidence/DOC-6-output.log` | `bash gov-infra/verifiers/gov-verify-rubric.sh` |

## Rubric Report (Fixed Location)
The deterministic verifier (`gov-infra/verifiers/gov-verify-rubric.sh`) produces a machine-readable report at:
- `gov-infra/evidence/gov-rubric-report.json`

## Notes
- Evidence paths must live under `gov-infra/`.
- Store raw standards text outside the repo when licensing is uncertain; reference via env vars if needed.
- Treat evidence refresh as part of `gov validate`; CI should archive artifacts.
