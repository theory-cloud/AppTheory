# AppTheory Documentation

<!-- AI Training: This is the documentation index for AppTheory -->
**This directory contains the OFFICIAL documentation for AppTheory. It follows the Pay Theory Documentation Guide so both humans and AI assistants can learn the runtime contract, apply correct patterns, and troubleshoot drift.**

## Quick links

### 🚀 Getting started
- [Getting Started](./getting-started.md) — install, run locally, and deploy.

### 📚 Core documentation
- [Docs Contract](./_contract.yaml) — canonical AppTheory knowledgebase scope: fixed ingestible, optional ingestible, and contract-only docs.
- [API Reference](./api-reference.md) — public surfaces + where to find the authoritative snapshots.
- [Core Patterns](./core-patterns.md) — canonical patterns (and anti-patterns) for routing, middleware, streaming, and errors.
- [Sanitization (Safe Logging)](./sanitization.md) — redact/mask PCI/PII fields and prevent log forging.
- [Jobs Ledger (Import Pipelines)](./jobs-ledger.md) — job/record status, leases, and idempotency primitives.
- [Bedrock AgentCore (MCP Gateway)](./agentcore-mcp.md) — deploy an MCP tool server for AgentCore (Go runtime + CDK).
- [MCP Server (Full Surface)](./mcp.md) — JSON-RPC methods, registries (tools/resources/prompts), payload shapes, and streaming notes.
- [Development Guidelines](./development-guidelines.md) — contract-only maintainer guidance for keeping the docs set aligned.
- [Testing Guide](./testing-guide.md) — unit tests, contract tests, and rubric verification.
- [Troubleshooting](./troubleshooting.md) — common symptoms → verified fixes.
- [Migration Guide](./migration-guide.md) — Lift → AppTheory and other migrations.

### 🧭 Reference examples
- [Import Pipeline Reference Stack](../examples/cdk/import-pipeline/README.md) — end-to-end wiring for Issue `#169` (S3 ingest → jobs ledger → SQS workers + optional CodeBuild step).

### 🧩 Language and package docs
- TypeScript package docs: `ts/docs/README.md`
- Python package docs: `py/docs/README.md`
- CDK constructs docs: `cdk/docs/README.md`

### 🤖 AI knowledge base (YAML triad)
- Docs Contract: `docs/_contract.yaml`
- Concepts: `docs/_concepts.yaml`
- Patterns: `docs/_patterns.yaml`
- Decisions: `docs/_decisions.yaml`

## Knowledgebase Canonical Set

- AppTheory knowledgebases should ingest the `fixed_ingestible` set declared in `docs/_contract.yaml` as the canonical core.
- `docs/_contract.yaml` and `docs/development-guidelines.md` are contract-only maintainer surfaces and should not be treated as user-facing knowledgebase content.
- Specialized root docs, package docs (`ts/docs/**`, `py/docs/**`, `cdk/docs/**`), and approved examples may be added only when the knowledgebase scope requires them.
- Planning material under `docs/development/**`, `docs/planning/**`, and `gov-infra/planning/**` is not canonical product documentation.

## Audience
- Platform/application teams building AWS Lambda APIs in Go/TypeScript/Python.
- Contributors maintaining cross-language parity and release artifacts.
- AI assistants answering questions about AppTheory usage and pitfalls.

## Planning vs. official docs
- **Official docs**: everything under this `docs/` folder (the files linked above).
- **Planning/roadmaps**: `docs/development/planning/apptheory/README.md` (workstreams, gap analyses, milestones).
