# AppTheory Documentation

<!-- Example output for docs/README.md -->
**This directory contains the OFFICIAL documentation for AppTheory. It is organized to support both human readers and KnowledgeTheory-ready ingestion without inventing undocumented behavior.**

## Quick Links

### Getting Started
- [Getting Started](./getting-started.md) - Install AppTheory, run a deterministic first workflow, and verify the toolchain.

### Core Documentation
- [API Reference](./api-reference.md) - Confirmed public interfaces, packages, commands, and configuration touchpoints.
- [Core Patterns](./core-patterns.md) - Canonical `CORRECT` and `INCORRECT` usage patterns.
- [Development Guidelines](./development-guidelines.md) - Contract-only maintainer guidance for keeping docs aligned.
- [Testing Guide](./testing-guide.md) - Test strategy, commands, and evidence expectations.
- [Troubleshooting](./troubleshooting.md) - Quick diagnosis plus concrete issue/fix guidance.
- [Migration Guide](./migration-guide.md) - Lift and raw-handler migration guidance.

### AI Knowledge Base
- [Docs Contract](./_contract.yaml) - Machine-readable docs contract and surface policy.
- [Concepts](./_concepts.yaml) - Machine-readable concept hierarchy.
- [Patterns](./_patterns.yaml) - Machine-readable preferred and rejected patterns.
- [Decisions](./_decisions.yaml) - Machine-readable adoption and architecture guidance.

## Audience
- Platform and application teams building AWS Lambda APIs and event handlers.
- Contributors maintaining cross-language parity across Go, TypeScript, Python, and CDK bindings.
- Operators validating releases, migrations, and troubleshooting steps.
- AI assistants answering repo-grounded questions about AppTheory.

## Document Map
- `README.md`: navigation hub and contract summary.
- `_contract.yaml`: machine-readable docs contract for the fixed docs set.
- `_concepts.yaml`: machine-readable concept map for AppTheory runtime, snapshots, and dispatch.
- `_patterns.yaml`: preferred patterns and anti-patterns grounded in current repo behavior.
- `_decisions.yaml`: decision trees for adoption, entrypoint selection, and migration posture.
- `getting-started.md`: prerequisites, installation posture, and first verification path.
- `api-reference.md`: confirmed public interfaces and source-of-truth locations.
- `core-patterns.md`: `CORRECT` and `INCORRECT` examples tied to repo realities.
- `development-guidelines.md`: contract-only maintainer guardrails.
- `testing-guide.md`: commands and verification expectations.
- `troubleshooting.md`: symptom-to-fix guidance.
- `migration-guide.md`: migration overview and cutover validation.

## KT Surface Summary
- Ingestible fixed docs:
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
- Contract-only docs:
  - `docs/_contract.yaml`
  - `docs/development-guidelines.md`
- Sanctioned optional ingestible surfaces:
  - `docs/migration/**`
  - `docs/llm-faq/**`
  - `docs/cdk/**`
- Out-of-scope surfaces:
  - `docs/development/**`
  - `docs/planning/**`
  - `docs/archive/**`

## Repo-Specific Scope Summary
AppTheory is a multi-language serverless application framework for AWS Lambda with a shared runtime contract across Go, TypeScript, and Python. Canonical public API surfaces are drift-gated through `api-snapshots/go.txt`, `api-snapshots/ts.txt`, and `api-snapshots/py.txt`. Current user-facing domains also include package-specific docs under `ts/docs/`, `py/docs/`, and `cdk/docs/`, plus migration details under `docs/migration/from-lift.md`.
