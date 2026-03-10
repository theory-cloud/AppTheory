# AppTheory Docs Init Guide

Generated: 2026-03-09

This artifact is **guide-only**. **Do not modify docs/ directly** from this action.
A local agent must apply or adapt the example outputs under `gov-infra/planning/docs-init-examples/` to the canonical docs surface.

## Purpose

- Scope summary: `UNKNOWN:` no explicit scope summary was provided in inputs; this guide is grounded in repository evidence.
- Canonical KT source root: `docs/`
- Selected documentation domains:
  - Runtime + public API surface (Go, TypeScript, Python)
  - Verification and quality gates
  - Migration and compatibility (Lift → AppTheory)
  - CDK operator surface
- Public/external surface summary:
  - Multi-language runtime package interfaces with snapshot-backed exports
  - Lambda HTTP/event adapter entrypoints and deterministic testkit APIs
  - Migration helper CLI (`cmd/lift-migrate`) with `-root` and `-apply`
  - Verification command surface (`make test-unit`, `./scripts/verify-contract-tests.sh`, `./scripts/update-api-snapshots.sh`, `make rubric`)
- Canonical sources consulted by domain:
  - Runtime/API: `docs/api-reference.md`, `api-snapshots/go.txt`, `api-snapshots/ts.txt`, `api-snapshots/py.txt`
  - Toolchains/first-run: `README.md`, `docs/getting-started.md`, `go.mod`, `Makefile`
  - Patterns/testing/troubleshooting: `docs/core-patterns.md`, `docs/testing-guide.md`, `docs/troubleshooting.md`
  - Migration: `docs/migration-guide.md`, `docs/migration/from-lift.md`, `cmd/lift-migrate/main.go`
  - Docs contract policy: `docs/README.md`, `docs/_contract.yaml`
  - Stranded runtime docs to consolidate: `ts/docs/README.md`, `py/docs/README.md`, `cdk/docs/README.md`

## Canonical KT Surface

- Canonical KT source root: `docs/`
- Fixed ingestible docs:
  - `docs/README.md`
  - `docs/_concepts.yaml`
  - `docs/_patterns.yaml`
  - `docs/_decisions.yaml`
  - `docs/getting-started.md`
  - `docs/api-reference.md`
  - `docs/core-patterns.md`
  - `docs/testing-guide.md`
  - `docs/troubleshooting.md`
  - `docs/migration-guide.md`
- Fixed contract-only docs:
  - `docs/_contract.yaml`
  - `docs/development-guidelines.md`
- Sanctioned optional ingestible surfaces:
  - `docs/migration/**`
  - `docs/llm-faq/**`
  - `docs/cdk/**`
- Non-canonical docs roots:
  - `docs/development/**`
  - `docs/planning/**`
  - `docs/internal/**`
  - `docs/archive/**`

## Example Outputs

These examples are scaffolding artifacts only. They map 1:1 to target docs paths.

| Example path (guide artifact) | Target repo path | Suggested local action | Evidence basis |
|---|---|---|---|
| `gov-infra/planning/docs-init-examples/README.md` | `docs/README.md` | adapt | `docs/README.md`, `README.md` |
| `gov-infra/planning/docs-init-examples/_contract.yaml` | `docs/_contract.yaml` | adapt | `docs/_contract.yaml` + server contract override |
| `gov-infra/planning/docs-init-examples/_concepts.yaml` | `docs/_concepts.yaml` | adapt | `docs/_concepts.yaml`, `README.md`, `docs/api-reference.md` |
| `gov-infra/planning/docs-init-examples/_patterns.yaml` | `docs/_patterns.yaml` | adapt | `docs/_patterns.yaml`, `docs/core-patterns.md` |
| `gov-infra/planning/docs-init-examples/_decisions.yaml` | `docs/_decisions.yaml` | adapt | `docs/_decisions.yaml`, `docs/migration-guide.md` |
| `gov-infra/planning/docs-init-examples/getting-started.md` | `docs/getting-started.md` | adapt | `docs/getting-started.md`, `go.mod`, `Makefile` |
| `gov-infra/planning/docs-init-examples/api-reference.md` | `docs/api-reference.md` | adapt | `docs/api-reference.md`, `api-snapshots/*`, `cmd/lift-migrate/main.go` |
| `gov-infra/planning/docs-init-examples/core-patterns.md` | `docs/core-patterns.md` | keep + expand | `docs/core-patterns.md` |
| `gov-infra/planning/docs-init-examples/development-guidelines.md` | `docs/development-guidelines.md` | adapt | `docs/development-guidelines.md` |
| `gov-infra/planning/docs-init-examples/testing-guide.md` | `docs/testing-guide.md` | keep + adapt | `docs/testing-guide.md`, `Makefile` |
| `gov-infra/planning/docs-init-examples/troubleshooting.md` | `docs/troubleshooting.md` | keep + expand | `docs/troubleshooting.md` |
| `gov-infra/planning/docs-init-examples/migration-guide.md` | `docs/migration-guide.md` | keep + adapt | `docs/migration-guide.md`, `docs/migration/from-lift.md` |

Decisions for sanctioned optional surfaces:

- `docs/migration/**`: keep + expand (already used and canonical)
- `docs/cdk/**`: keep + expand (canonical optional destination for infra guidance)
- `docs/llm-faq/**`: create only if repo owners provide stable user-facing Q/A content

## Cleanup And Consolidation Plan

1. Preserve `docs/` as the only canonical KT root for ingestible and contract-only docs.
2. Merge or move user-facing runtime guidance stranded outside canonical root:
   - `ts/docs/**` → merge missing user-facing runtime details into `docs/getting-started.md`, `docs/api-reference.md`, and `docs/core-patterns.md`.
   - `py/docs/**` → merge missing parity/testing guidance into `docs/testing-guide.md` and `docs/troubleshooting.md`.
   - `cdk/docs/**` → move/merge canonical operator guidance into `docs/cdk/**` (sanctioned optional ingestible surface).
3. Remove duplicate canonical claims in non-canonical/package-local docs roots after merge to reduce drift.
4. Split oversized pages only when needed:
   - keep fixed filenames intact,
   - place overflow migration content under `docs/migration/**`,
   - place CDK operator overflow under `docs/cdk/**`.
5. Do not place user-facing canonical guidance in `docs/development/**`, `docs/planning/**`, `docs/internal/**`, or `docs/archive/**`.

## Local Agent Apply Steps

1. Treat this plan as guide-only scaffolding; apply changes in `docs/` with adaptation over wholesale replacement.
2. For each mapped file above, copy structure from its example and merge repository-specific content already present in canonical docs.
3. Keep/expand existing high-quality repo-grounded sections (especially in `docs/api-reference.md`, `docs/core-patterns.md`, `docs/testing-guide.md`, `docs/troubleshooting.md`, and `docs/migration-guide.md`).
4. Enforce canonical vs non-canonical boundaries:
   - canonical: fixed docs + sanctioned optional surfaces under `docs/`
   - non-canonical: `docs/development/**`, `docs/planning/**`, `docs/internal/**`, `docs/archive/**`
5. Consolidate runtime docs currently outside `docs/` by merging or moving user-facing content from `ts/docs/**`, `py/docs/**`, and `cdk/docs/**` into canonical destinations.
6. Preserve explicit uncertainty instead of guessing:
   - `UNKNOWN:` broader stable CLI contract beyond `cmd/lift-migrate` is not confirmed.
   - `UNKNOWN:` complete env-var/config-key inventory is not centralized in one canonical file.
   - `TODO:` add a dedicated canonical configuration section once source-of-truth ownership is declared.
7. Validate doc correctness against repo commands/interfaces before publish:
   - `make test-unit`
   - `./scripts/verify-contract-tests.sh`
   - `./scripts/update-api-snapshots.sh`
   - `./scripts/verify-api-snapshots.sh`
   - `./scripts/verify-docs-standard.sh`
   - `make rubric`

## Review Checklist

- Canonical KT source root is explicitly `docs/`.
- Canonical vs non-canonical docs roots are clearly separated.
- Every target docs file has a mapped example under `gov-infra/planning/docs-init-examples/`.
- `docs/README.md` links to all fixed docs and machine-readable files.
- `_contract.yaml` example uses top-level `contract:` map and server-required shape.
- `_concepts.yaml`, `_patterns.yaml`, `_decisions.yaml` examples use required top-level roots and include repo-specific entries.
- `getting-started.md` includes prerequisites, installation, and verification.
- `core-patterns.md` includes explicit `CORRECT` and `INCORRECT` examples.
- `development-guidelines.md` explicitly states contract-only usage.
- `troubleshooting.md` includes quick diagnosis and concrete issue/fix entries.
- `migration-guide.md` does not direct readers to `docs/development/**`, `docs/planning/**`, `docs/internal/**`, or `docs/archive/**`.
- No unresolved template placeholder tokens remain.

## Publish Acceptance Criteria

- Canonical publish set exists under `docs/` and matches fixed filenames.
- Contract-only pages remain clearly identified and do not absorb user-facing planning/process material.
- Ingestible docs do not link to non-canonical roots (`docs/development/**`, `docs/planning/**`, `docs/internal/**`, `docs/archive/**`).
- API claims are grounded in snapshots/docs evidence; unknowns are marked as `UNKNOWN:` or `TODO:`.
- Optional surfaces are limited to sanctioned paths (`docs/migration/**`, `docs/llm-faq/**`, `docs/cdk/**`).
- Runtime guidance stranded outside canonical root has an explicit merge/move outcome.

## Publish Notes

- This scaffold intentionally favors grounded partial output over speculative completeness.
- `UNKNOWN:` Full, stable public CLI contract for all `cmd/**` binaries beyond `lift-migrate` remains to be confirmed.
- `UNKNOWN:` A complete canonical config/env matrix is not currently centralized.
- `TODO:` After consolidation, re-run docs verification and snapshot gates to ensure no drift.
- Reminder: this action remains guide-only and local-agent-applied.
