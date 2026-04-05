# Theory Cloud

Theory Cloud is an open-source framework stack for building serverless applications on AWS. It is designed around a
single principle: **one correct path per domain.**

## The Problem

AI code generation is non-deterministic. Ask a model to build the same endpoint twice and you get two different
implementations — different error handling, different middleware ordering, different serialization choices. Scale this
across languages, teams, and services, and the result is drift: systems that pass their own tests but fail when they
interact.

Traditional frameworks offer flexibility. They provide multiple ways to accomplish the same task and leave the choice
to the developer. This is a feature when humans are writing all the code and can maintain mental models of their own
decisions. It becomes a liability when generative tools are producing code at scale, because flexibility is where
drift enters.

## The Approach

Theory Cloud constrains each domain to a single path. Not one recommended path with alternatives — one path, enforced
by the framework.

- **One path to data.** [TableTheory](https://github.com/theory-cloud/TableTheory) provides a single way to define,
  access, and secure DynamoDB data across Go, TypeScript, and Python. Encrypted fields fail closed — if the KMS key isn't configured, any read of an
  encrypted field returns an error instead of silently returning plaintext. There is no "raw SDK escape hatch" that bypasses the security model.

- **One path to runtime behavior.** [AppTheory](https://github.com/theory-cloud/AppTheory) provides a single
  application model for AWS Lambda: routing, middleware, error handling, and event normalization. The same handler
  code in Go, TypeScript, or Python produces the same HTTP response, verified by 89 shared contract test fixtures.

- **One path to client delivery.** [FaceTheory](https://github.com/theory-cloud/FaceTheory) provides a single model
  for SSR, SSG, and ISR on AWS Lambda + CloudFront, with adapter support for React, Vue, and Svelte.

The constraint is the feature. When every service uses the same patterns, generative coding tools produce consistent
output. Code reviews become faster because there are fewer valid shapes to check. Cross-service integration works
because the behavioral contract is enforced, not assumed.

## The Stack

```
┌─────────────────────────────────────────────────┐
│                  FaceTheory                      │
│         Client application delivery              │
│         SSR / SSG / ISR on AWS                   │
│              (optional)                          │
├─────────────────────────────────────────────────┤
│                  AppTheory                       │
│         Serverless runtime + CDK constructs      │
│         HTTP, MCP, AppSync, WebSocket            │
│         Go, TypeScript, Python                   │
├─────────────────────────────────────────────────┤
│                 TableTheory                      │
│         Data access + security                   │
│         DynamoDB, encryption, DMS spec           │
│         Go, TypeScript, Python                   │
└─────────────────────────────────────────────────┘
```

**TableTheory** has no dependencies in the stack. It is the foundation.

**AppTheory** depends on TableTheory for data access patterns and provides the runtime, CDK deployment constructs,
and MCP server implementation.

**FaceTheory** depends on both TableTheory and AppTheory. It is only needed when the application includes a web UI.

## Cross-Language Parity

Theory Cloud supports Go, TypeScript, and Python not through separate implementations that happen to share a name,
but through contract-enforced behavioral parity.

Each framework maintains a set of shared test fixtures — language-neutral descriptions of expected behavior. The Go,
TypeScript, and Python runtimes are independently tested against these same fixtures. If a timestamp format, error
envelope structure, or middleware ordering differs between languages, the contract tests fail.

TableTheory additionally defines a [DMS (Data Model Specification)](https://github.com/theory-cloud/TableTheory)
that serves as the language-neutral source of truth for data models. All three SDKs validate against the same DMS
fixtures.

This means cross-language consistency is verified on every commit, not reviewed in a quarterly audit.

## Production Use

Theory Cloud frameworks are developed by the technical team at [Pay Theory](https://paytheory.com), where they run
production payment processing systems. The frameworks were extracted and open-sourced to demonstrate the single-path
approach to serverless development and to support the broader community of developers using generative coding tools.

## Repositories

| Repository | Purpose | Languages |
|------------|---------|-----------|
| [TableTheory](https://github.com/theory-cloud/TableTheory) | Data access, security, DMS spec | Go, TypeScript, Python |
| [AppTheory](https://github.com/theory-cloud/AppTheory) | Serverless runtime, CDK, MCP | Go, TypeScript, Python |
| [FaceTheory](https://github.com/theory-cloud/FaceTheory) | Client delivery (SSR/SSG/ISR) | TypeScript |
