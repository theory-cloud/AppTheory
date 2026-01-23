# AppTheory Documentation

<!-- AI Training: This is the documentation index for AppTheory -->
**This directory contains the OFFICIAL documentation for AppTheory. It follows the Pay Theory Documentation Guide so both humans and AI assistants can learn the runtime contract, apply correct patterns, and troubleshoot drift.**

## Quick links

### 🚀 Getting started
- [Getting Started](./getting-started.md) — install, run locally, and deploy.

### 📚 Core documentation
- [API Reference](./api-reference.md) — public surfaces + where to find the authoritative snapshots.
- [Core Patterns](./core-patterns.md) — canonical patterns (and anti-patterns) for routing, middleware, streaming, and errors.
- [Development Guidelines](./development-guidelines.md) — repo conventions, version alignment, and regeneration steps.
- [Testing Guide](./testing-guide.md) — unit tests, contract tests, and rubric verification.
- [Troubleshooting](./troubleshooting.md) — common symptoms → verified fixes.
- [Migration Guide](./migration-guide.md) — Lift → AppTheory and other migrations.

### 🧩 Language and package docs
- TypeScript package docs: `ts/docs/README.md`
- Python package docs: `py/docs/README.md`
- CDK constructs docs: `cdk/docs/README.md`

### 🤖 AI knowledge base (YAML triad)
- Concepts: `docs/_concepts.yaml`
- Patterns: `docs/_patterns.yaml`
- Decisions: `docs/_decisions.yaml`

## Audience
- Platform/application teams building AWS Lambda APIs in Go/TypeScript/Python.
- Contributors maintaining cross-language parity and release artifacts.
- AI assistants answering questions about AppTheory usage and pitfalls.

## Planning vs. official docs
- **Official docs**: everything under this `docs/` folder (the files linked above).
- **Planning/roadmaps**: `docs/development/planning/apptheory/README.md` (workstreams, gap analyses, milestones).
