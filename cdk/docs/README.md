# AppTheory CDK Documentation

<!-- AI Training: This is the documentation index for AppTheory CDK -->
**This directory contains the OFFICIAL documentation for the AppTheory CDK package (`@theory-cloud/apptheory-cdk`, Python: `apptheory_cdk`). It follows the Pay Theory Documentation Guide and focuses on copy/paste ready infrastructure patterns.**

## Quick links

### 🚀 Getting started
- [Getting Started](./getting-started.md) — deploy a minimal API backed by an AppTheory Lambda.

### 📚 Core documentation
- [API Reference](./api-reference.md) — construct inventory and key props.
- [Core Patterns](./core-patterns.md) — safe defaults, domains/certs, alarms, and proxy routing.
- [Development Guidelines](./development-guidelines.md) — jsii build flow and regeneration steps.
- [Testing Guide](./testing-guide.md) — how to run CDK tests and synth checks.
- [Troubleshooting](./troubleshooting.md) — common synth/deploy failures.
- [Migration Guide](./migration-guide.md) — moving from ad-hoc CDK stacks.

### 🧭 Guides (copy/paste patterns)
- [REST API v1 Router + Streaming](./rest-api-router-streaming.md) — multi-Lambda REST API v1 + full response streaming parity.
- [SQS Queue + Consumer Patterns](./sqs-queue-consumer.md) — queue-only, queue+consumer, and processor patterns (DLQs + partial batch failures).
- [Lambda Role Helper](./lambda-role.md) — Lambda execution roles (baseline + X-Ray + KMS + custom statements).
- [CloudFront Path-Routed Frontend Distribution](./path-routed-frontend.md) — multi-SPA routing behind one stage domain.
- [Media CDN Pattern](./media-cdn.md) — S3 + CloudFront distribution for media subdomains (optional private media).

### 🤖 AI knowledge base (YAML triad)
- Concepts: `cdk/docs/_concepts.yaml`
- Patterns: `cdk/docs/_patterns.yaml`
- Decisions: `cdk/docs/_decisions.yaml`

## What this package is

AppTheory CDK provides jsii constructs that deploy AppTheory apps with consistent defaults (and keep infra patterns consistent across Go/TypeScript/Python services).
