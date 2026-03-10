# AppTheory Python Documentation

<!-- AI Training: This is the OFFICIAL documentation index for AppTheory Python -->
**This directory contains the OFFICIAL package-local documentation for the AppTheory Python package (`apptheory`). For canonical cross-language external guidance, start at `docs/README.md`; use this directory for Python-specific quick starts, package build details, and maintainer-facing mirrors.**

## Quick links

### 🚀 Getting started
- [Getting Started](./getting-started.md) — install and run your first route locally.
- [Canonical Getting Started](../../docs/getting-started.md) — cross-language onboarding under the canonical docs root.

### 📚 Core documentation
- [Docs Contract](./_contract.yaml) — canonical Python package knowledgebase scope: fixed ingestible, optional ingestible, and contract-only docs.
- [API Reference](./api-reference.md) — key exports and where to find the authoritative public surface.
- [Core Patterns](./core-patterns.md) — routing, middleware, streaming, SSE, and error patterns.
- [Development Guidelines](./development-guidelines.md) — contract-only maintainer guidance for keeping the package docs set aligned.
- [Testing Guide](./testing-guide.md) — unit tests, contract tests, and repo gates.
- [Troubleshooting](./troubleshooting.md) — common failures and fixes.
- [Migration Guide](./migration-guide.md) — moving from raw handlers/frameworks.
- [Canonical Docs Index](../../docs/README.md) — canonical external navigation root for AppTheory.

### 🤖 AI knowledge base (YAML triad)
- Docs Contract: `py/docs/_contract.yaml`
- Concepts: `py/docs/_concepts.yaml`
- Patterns: `py/docs/_patterns.yaml`
- Decisions: `py/docs/_decisions.yaml`

## Package-local scope

- `docs/` is the canonical external docs root for AppTheory.
- `py/docs/` remains an official package-local surface for Python-specific examples and authoring details.
- Reflect shared user-facing guidance in `docs/` before treating `py/docs/` content as complete.
- `py/docs/_contract.yaml` and `py/docs/development-guidelines.md` are contract-only maintainer surfaces and should not be treated as user-facing knowledgebase content.
- `api-snapshots/py.txt` and `py/README.md` are sanctioned optional sources when a knowledgebase needs export-level or package-root context.

## Contract note

Portable behavior is defined by the fixture-backed contract:
`docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`.
