# AppTheory Python Documentation

<!-- AI Training: This is the documentation index for AppTheory Python -->
**This directory contains the OFFICIAL documentation for the AppTheory Python package (`apptheory`). It follows the Pay Theory Documentation Guide and is designed to work well with generative coding workflows.**

## Quick links

### 🚀 Getting started
- [Getting Started](./getting-started.md) — install and run your first route locally.

### 📚 Core documentation
- [Docs Contract](./_contract.yaml) — canonical Python package knowledgebase scope: fixed ingestible, optional ingestible, and contract-only docs.
- [API Reference](./api-reference.md) — key exports and where to find the authoritative public surface.
- [Core Patterns](./core-patterns.md) — routing, middleware, streaming, SSE, and error patterns.
- [Development Guidelines](./development-guidelines.md) — contract-only maintainer guidance for keeping the package docs set aligned.
- [Testing Guide](./testing-guide.md) — unit tests, contract tests, and repo gates.
- [Troubleshooting](./troubleshooting.md) — common failures and fixes.
- [Migration Guide](./migration-guide.md) — moving from raw handlers/frameworks.

### 🤖 AI knowledge base (YAML triad)
- Docs Contract: `py/docs/_contract.yaml`
- Concepts: `py/docs/_concepts.yaml`
- Patterns: `py/docs/_patterns.yaml`
- Decisions: `py/docs/_decisions.yaml`

## Knowledgebase Canonical Set

- Python package knowledgebases should ingest the `fixed_ingestible` set declared in `py/docs/_contract.yaml` as the canonical core.
- `py/docs/_contract.yaml` and `py/docs/development-guidelines.md` are contract-only maintainer surfaces and should not be treated as user-facing knowledgebase content.
- `api-snapshots/py.txt` and `py/README.md` are sanctioned optional sources when a knowledgebase needs export-level or package-root context.

## Contract note

Portable behavior is defined by the fixture-backed contract:
`docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`.
